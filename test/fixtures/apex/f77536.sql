prompt --application/set_environment
set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
--------------------------------------------------------------------------------
--
-- Oracle APEX export file
--
-- You should run this script using a SQL client connected to the database as
-- the owner (parsing schema) of the application or as a database user with the
-- APEX_ADMINISTRATOR_ROLE role.
--
-- This export file has been automatically generated. Modifying this file is not
-- supported by Oracle and can lead to unexpected application and/or instance
-- behavior now or in the future.
--
-- NOTE: Calls to apex_application_install override the defaults below.
--
--------------------------------------------------------------------------------
begin
wwv_flow_imp.import_begin (
 p_version_yyyy_mm_dd=>'2026.04.07'
,p_release=>'26.2.1'
,p_default_workspace_id=>1000000000000000001
,p_default_application_id=>77536
,p_default_id_offset=>0
,p_default_owner=>'WKSP_DEMO'
);
end;
/
 
prompt APPLICATION 77536 - Demonstration - HR
--
-- Application Export:
--   Application:     77536
--   Name:            Demonstration - HR
--   Date and Time:   12:15 Saturday November 14, 2026
--   Exported By:     DEVELOPER
--   Flashback:       0
--   Export Type:     Application Export
--     Pages:                     46
--       Items:                  112
--       Validations:              2
--       Processes:               47
--       Regions:                109
--       Buttons:                 73
--       Dynamic Actions:         16
--     Shared Components:
--       Logic:
--         App Settings:           2
--         Build Options:          9
--       Navigation:
--         Lists:                 10
--         Breadcrumbs:            1
--           Entries:              7
--       Security:
--         Authentication:         2
--         Authorization:          3
--         ACL Roles:              3
--       User Interface:
--         Themes:                 1
--         Templates:
--         LOVs:                  15
--       PWA:
--       Globalization:
--       Reports:
--       E-Mail:
--     Supporting Objects:  Included
--   Version:         26.2.1
--   Instance ID:     63113759365424
--

prompt --application/delete_application
begin
wwv_flow_imp.remove_flow(wwv_flow.g_flow_id);
end;
/
prompt --application/create_application
begin
wwv_imp_workspace.create_flow(
 p_id=>wwv_flow.g_flow_id
,p_owner=>nvl(wwv_flow_application_install.get_schema,'WKSP_DEMO')
,p_name=>nvl(wwv_flow_application_install.get_application_name,'Demonstration - HR')
,p_alias=>nvl(wwv_flow_application_install.get_application_alias,'DEMONSTRATION-HR')
,p_page_view_logging=>'YES'
,p_page_protection_enabled_y_n=>'Y'
,p_checksum_salt=>'244B8E9B0445C383146F13CF572BFC68932CB7C5B299CF2131DC6753A217C122'
,p_bookmark_checksum_function=>'SH512'
,p_compatibility_mode=>'26.1'
,p_flow_language=>'en'
,p_flow_language_derived_from=>'FLOW_PRIMARY_LANGUAGE'
,p_allow_feedback_yn=>'Y'
,p_date_format=>'DS'
,p_timestamp_format=>'DS'
,p_timestamp_tz_format=>'DS'
,p_flow_image_prefix=>nvl(wwv_flow_application_install.get_image_prefix,'')
,p_authentication_id=>wwv_flow_imp.id(3435047377239279134)
,p_application_tab_set=>1
,p_logo_type=>'T'
,p_logo_text=>'Demonstration - HR'
,p_proxy_server=>nvl(wwv_flow_application_install.get_proxy,'')
,p_no_proxy_domains=>nvl(wwv_flow_application_install.get_no_proxy_domains,'')
,p_flow_version=>'Release 1.0'
,p_flow_status=>'AVAILABLE_W_EDIT_LINK'
,p_browser_cache=>'N'
,p_browser_frame=>'D'
,p_runtime_api_usage=>'T'
,p_authorize_batch_job=>'N'
,p_rejoin_existing_sessions=>'N'
,p_csv_encoding=>'Y'
,p_substitution_string_01=>'APP_NAME'
,p_substitution_value_01=>'Demonstration - HR'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014072017Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
,p_file_prefix=>nvl(wwv_flow_application_install.get_static_app_file_prefix,'')
,p_files_version=>2461328071306
,p_version_scn=>'15845481996056'
,p_print_server_type=>'INSTANCE'
,p_file_storage=>'DB'
,p_is_pwa=>'Y'
,p_pwa_is_installable=>'Y'
,p_pwa_manifest_display=>'standalone'
,p_pwa_manifest_orientation=>'any'
,p_pwa_is_push_enabled=>'Y'
,p_pwa_push_credential_id=>3417108328429217547
,p_theme_id=>42
,p_home_url=>'f?p=&APP_ID.:1:&APP_SESSION.::&DEBUG.:::'
,p_login_url=>'f?p=&APP_ID.:LOGIN:&APP_SESSION.::&DEBUG.:::'
,p_theme_style_by_user_pref=>false
,p_global_page_id=>0
,p_navigation_list_id=>wwv_flow_imp.id(3415215420357210816)
,p_navigation_list_position=>'SIDE'
,p_navigation_list_template_id=>2471166859590295591
,p_nav_list_template_options=>'#DEFAULT#:t-TreeNav--styleA:js-navCollapsed--hidden'
,p_nav_bar_type=>'LIST'
,p_nav_bar_list_id=>wwv_flow_imp.id(3415216261898210821)
,p_nav_bar_list_template_id=>2850970698196720012
,p_nav_bar_template_options=>'#DEFAULT#'
);
end;
/
prompt --workspace/credentials/app_77536_push_notifications_credentials
begin
wwv_imp_workspace.create_credential(
 p_id=>3417108328429217547
,p_name=>'App 77536 Push Notifications Credentials'
,p_static_id=>'app-77536-push-notifications-credentials'
,p_authentication_type=>'KEY_PAIR'
,p_prompt_on_install=>false
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071414Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/plugin_settings
begin
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415210161328210807)
,p_plugin_type=>'DYNAMIC ACTION'
,p_plugin=>'NATIVE_OPEN_AI_ASSISTANT'
,p_version_scn=>'SH256:NcagEyRP_F17oe14bnrSYSYienkBgpdRSvH17g_NxoE'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415210449003210809)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_COLOR_PICKER'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'display_as', 'POPUP',
  'mode', 'FULL')).to_clob
,p_version_scn=>'SH256:FJR60MFzlfEjx0PvnpYBK4631rNeUHXaF3eGFKxcTgE'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415210740420210809)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_DATE_PICKER_APEX'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'appearance_behavior', 'MONTH-PICKER:YEAR-PICKER:TODAY-BUTTON',
  'days_outside_month', 'VISIBLE',
  'show_on', 'FOCUS',
  'time_increment', '15')).to_clob
,p_version_scn=>'SH256:dQTHqehcDG0h-d-qmHe5lf-DuViElEHDw9zMkscLr6M'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415211026362210809)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_GEOCODED_ADDRESS'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'background', 'default',
  'display_as', 'LIST',
  'map_preview', 'POPUP:ITEM',
  'match_mode', 'RELAX_HOUSE_NUMBER')).to_clob
,p_version_scn=>'SH256:CU9J9l4sUtY-UffjdBCosfDW6ER-I0swXpw8GekLiYQ'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415211303943210810)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_SELECT_MANY'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'display_values_as', 'separated')).to_clob
,p_version_scn=>'SH256:jJTPfH8wphTXe7ahDytF6PbWlPl1mXrDRYylCDda0k0'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415211666084210810)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_SINGLE_CHECKBOX'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'checked_value', 'Y',
  'unchecked_value', 'N')).to_clob
,p_version_scn=>'SH256:oAqKgc-cSRXHDMjfwwNIgo78WqYXKjQz8MWGBG6Euj0'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415211928961210811)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_STAR_RATING'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'default_icon', 'fa-star',
  'tooltip', '#VALUE#')).to_clob
,p_version_scn=>'SH256:uT4QhQbZQY61UFxAGl7ieo2urrCo8jUsFNprrg7lGHo'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415212264813210811)
,p_plugin_type=>'ITEM TYPE'
,p_plugin=>'NATIVE_YES_NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'display_style', 'SWITCH_CB',
  'off_value', 'N',
  'on_value', 'Y')).to_clob
,p_version_scn=>'SH256:wAjuCAsVhoIbbuKGWTMQ__Rd_YS_sY9KgWhpqOO11mc'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415212592127210812)
,p_plugin_type=>'PROCESS TYPE'
,p_plugin=>'NATIVE_GEOCODING'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'match_mode', 'RELAX_HOUSE_NUMBER')).to_clob
,p_version_scn=>'SH256:GIeRbUJQ8yKfen6-dFvkghmSUZXFoUAXCCTNRhCJgh0'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415212881047210812)
,p_plugin_type=>'REGION TYPE'
,p_plugin=>'NATIVE_DISPLAY_SELECTOR'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'include_slider', 'Y')).to_clob
,p_version_scn=>'SH256:4M27aN0U-JyQ0prILtI8ITLXOphqUdO-xWNcwkSL1SI'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415213130842210812)
,p_plugin_type=>'REGION TYPE'
,p_plugin=>'NATIVE_IR'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'actions_menu_structure', 'IG',
  'auto_ir_reset_button', 'Y')).to_clob
,p_version_scn=>'SH256:TC1mqO_n1hWvorH6XHVejgQzJq9VjDsWoq0rKaIQUNo'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415213439055210813)
,p_plugin_type=>'REGION TYPE'
,p_plugin=>'NATIVE_MAP_REGION'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'use_vector_tile_layers', 'Y')).to_clob
,p_version_scn=>'SH256:vJP7K77hiNj1R2RE6dHVyRAhlmxDg6KGn4yRE20J9Qw'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415213717920210813)
,p_plugin_type=>'WEB SOURCE TYPE'
,p_plugin=>'NATIVE_ADFBC'
,p_version_scn=>'SH256:fiSZ-OfcUl-d0e0dtJUYffG7q61xKsHlomsv7ZU1BMw'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_plugin_setting(
 p_id=>wwv_flow_imp.id(3415214039302210814)
,p_plugin_type=>'WEB SOURCE TYPE'
,p_plugin=>'NATIVE_BOSS'
,p_version_scn=>'SH256:dRkCWi6vQMhdQUSqb0QlRls9iYcsZ93IPYrbTqFqJFE'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/access_control
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417075510938217510)
,p_name=>'Access Control'
,p_static_id=>'access-control'
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_version_scn=>'SH256:sUh16YlciRG9klSoZtcZTfvvJD2zYdjKQV9D3IfGUbU'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417076852406217511)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Access Control'
,p_static_id=>'access-control'
,p_list_item_link_target=>'f?p=&APP_ID.:10040:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-key'
,p_list_text_01=>'Change access control settings and disable access control'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417076145410217510)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Users'
,p_static_id=>'users'
,p_list_item_link_target=>'f?p=&APP_ID.:10041:&APP_SESSION.::&DEBUG.:RP::'
,p_list_item_icon=>'fa-users'
,p_list_text_01=>'Set level of access for authenticated users of this application'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/activity_reports
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417071137395217505)
,p_name=>'Activity Reports'
,p_static_id=>'activity-reports'
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_version_scn=>'SH256:YHgkfo-ih9pxHHGLxqP0cHF8ck23_hWgwdn-JBp8Nts'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417073045796217507)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'Application Error Log'
,p_static_id=>'application-error-log'
,p_list_item_link_target=>'f?p=&APP_ID.:10032:&APP_SESSION.::&DEBUG.:10032::'
,p_list_item_icon=>'fa-exclamation'
,p_list_text_01=>'Report of errors logged by this application'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417075023853217509)
,p_list_item_display_sequence=>60
,p_list_item_link_text=>'Automations Log'
,p_static_id=>'automations-log'
,p_list_item_link_target=>'f?p=&APP_ID.:10035:&APP_SESSION.::&DEBUG.:RR,10035::'
,p_list_item_icon=>'fa-gears'
,p_list_item_disp_cond_type=>'EXISTS'
,p_list_item_disp_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'from apex_appl_automations a, apex_automation_log l',
'where a.automation_id = l.automation_id',
'and l.application_id = :APP_ID'))
,p_list_text_01=>'Report of automation executions and messages logged by this application'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417071703336217506)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Dashboard'
,p_static_id=>'dashboard'
,p_list_item_link_target=>'f?p=&APP_ID.:10030:&APP_SESSION.::&DEBUG.:10030::'
,p_list_item_icon=>'fa-area-chart'
,p_list_text_01=>'View application activity metrics'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417073703275217508)
,p_list_item_display_sequence=>40
,p_list_item_link_text=>'Page Performance'
,p_static_id=>'page-performance'
,p_list_item_link_target=>'f?p=&APP_ID.:10033:&APP_SESSION.::&DEBUG.:10033::'
,p_list_item_icon=>'fa-file-chart'
,p_list_text_01=>'Report of activity and performance by application page'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417074479262217509)
,p_list_item_display_sequence=>50
,p_list_item_link_text=>'Page Views'
,p_static_id=>'page-views'
,p_list_item_link_target=>'f?p=&APP_ID.:10034:&APP_SESSION.::&DEBUG.:RR,10034::'
,p_list_item_icon=>'fa-file-search'
,p_list_text_01=>'Report of each page view by user including date of access and elapsed time'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417072493611217507)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Top Users'
,p_static_id=>'top-users'
,p_list_item_link_target=>'f?p=&APP_ID.:10031:&APP_SESSION.::&DEBUG.:10031::'
,p_list_item_icon=>'fa-user-chart'
,p_list_text_01=>'Report of page views aggregated by user'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/application_administration
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417078436266217513)
,p_name=>'Application Administration'
,p_static_id=>'application-administration'
,p_version_scn=>'SH256:CS6TgsjdqXfSXF-cwfAv5ydjBIKsAXzpWvjRRWe96NU'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417079795826217514)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Countries'
,p_static_id=>'countries'
,p_list_item_link_target=>'f?p=&APP_ID.:12:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417082413670217516)
,p_list_item_display_sequence=>60
,p_list_item_link_text=>'Departments'
,p_static_id=>'departments'
,p_list_item_link_target=>'f?p=&APP_ID.:20:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417081881144217516)
,p_list_item_display_sequence=>50
,p_list_item_link_text=>'Jobs'
,p_static_id=>'jobs'
,p_list_item_link_target=>'f?p=&APP_ID.:18:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417081138610217515)
,p_list_item_display_sequence=>40
,p_list_item_link_text=>'Products'
,p_static_id=>'products'
,p_list_item_link_target=>'f?p=&APP_ID.:16:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417079154283217513)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Regions'
,p_static_id=>'regions'
,p_list_item_link_target=>'f?p=&APP_ID.:10:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417080596590217514)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'Warehouses'
,p_static_id=>'warehouses'
,p_list_item_link_target=>'f?p=&APP_ID.:14:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_text_01=>'Manage component'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/application_configuration
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417068846300217503)
,p_name=>'Application Configuration'
,p_static_id=>'application-configuration'
,p_required_patch=>wwv_flow_imp.id(3415219141650210834)
,p_version_scn=>'SH256:01z6ukJ0-1Z6Us8cQjg4pfcVIVbOCpaLhLFvRKRxDnA'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417069504633217503)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Configuration Options'
,p_static_id=>'configuration-options'
,p_list_item_link_target=>'f?p=&APP_ID.:10010:&APP_SESSION.::&DEBUG.:10010::'
,p_list_item_icon=>'fa-sliders'
,p_list_text_01=>'Enable or disable application features'
,p_required_patch=>wwv_flow_imp.id(3415219141650210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/feedback
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417077221528217511)
,p_name=>'Feedback'
,p_static_id=>'feedback'
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_version_scn=>'SH256:s15aWBuZhABHOwKzpyU4guxD38vSpSxZDCaivjs8UQE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417077984328217512)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'User Feedback'
,p_static_id=>'user-feedback'
,p_list_item_link_target=>'f?p=&APP_ID.:10053:&APP_SESSION.::&DEBUG.:10053::'
,p_list_item_icon=>'fa-comment-o'
,p_list_text_01=>'Report of all feedback submitted by application users'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/navigation_bar
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3415216261898210821)
,p_name=>'Navigation Bar'
,p_static_id=>'navigation-bar'
,p_version_scn=>'SH256:ENfiZ0d6Nh4i08WFwpUfYcw1twtXcOUNWso2u-lTLsE'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417061932197217495)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'About'
,p_static_id=>'about'
,p_list_item_icon=>'fa-question-circle-o'
,p_list_text_02=>'icon-only'
,p_required_patch=>wwv_flow_imp.id(3415219407143210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417064134759217497)
,p_list_item_display_sequence=>60
,p_list_item_link_text=>'About Page'
,p_static_id=>'about-page'
,p_list_item_link_target=>'f?p=&APP_ID.:10060:&APP_SESSION.::&DEBUG.:10060::'
,p_list_item_icon=>'fa-info-circle-o'
,p_parent_list_item_id=>wwv_flow_imp.id(3417061932197217495)
,p_required_patch=>wwv_flow_imp.id(3415219407143210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417060847893217494)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Install App'
,p_static_id=>'action-a-pwa-install'
,p_list_item_link_target=>'#action$a-pwa-install'
,p_list_item_icon=>'fa-cloud-download'
,p_list_text_02=>'a-pwaInstall'
,p_list_item_current_type=>'NEVER'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417064524503217498)
,p_list_item_display_sequence=>70
,p_list_item_link_text=>'&APP_USER.'
,p_static_id=>'app-user'
,p_list_item_link_target=>'#'
,p_list_item_icon=>'fa-user'
,p_list_text_02=>'has-username'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417061564973217495)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Feedback'
,p_static_id=>'feedback'
,p_list_item_link_target=>'f?p=&APP_ID.:10050:&APP_SESSION.::&DEBUG.:RP,10050:P10050_PAGE_ID:&APP_PAGE_ID.'
,p_list_item_icon=>'fa-comment-o'
,p_list_item_disp_cond_type=>'EXPRESSION'
,p_list_item_disp_condition=>'apex_util.feedback_enabled'
,p_list_item_disp_condition2=>'PLSQL'
,p_list_text_02=>'icon-only'
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417063448433217497)
,p_list_item_display_sequence=>50
,p_list_item_link_text=>'---'
,p_static_id=>'list_item'
,p_list_item_link_target=>'separator'
,p_parent_list_item_id=>wwv_flow_imp.id(3417061932197217495)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417065473312217499)
,p_list_item_display_sequence=>80
,p_list_item_link_text=>'---'
,p_static_id=>'list_item-2'
,p_list_item_link_target=>'separator'
,p_list_item_disp_cond_type=>'USER_IS_NOT_PUBLIC_USER'
,p_parent_list_item_id=>wwv_flow_imp.id(3417064524503217498)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417062769749217496)
,p_list_item_display_sequence=>40
,p_list_item_link_text=>'Page Help'
,p_static_id=>'page-help'
,p_list_item_link_target=>'f?p=&APP_ID.:10061:&APP_SESSION.::&DEBUG.::P10061_PAGE_ID:&APP_PAGE_ID.'
,p_list_item_icon=>'fa-question-circle-o'
,p_parent_list_item_id=>wwv_flow_imp.id(3417061932197217495)
,p_list_text_02=>'icon-only'
,p_required_patch=>wwv_flow_imp.id(3415219407143210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417107874645217547)
,p_list_item_display_sequence=>1
,p_list_item_link_text=>'Settings'
,p_static_id=>'settings'
,p_list_item_link_target=>'f?p=&APP_ID.:20000:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-gear'
,p_parent_list_item_id=>wwv_flow_imp.id(3417064524503217498)
,p_required_patch=>wwv_flow_imp.id(3417098503295217537)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417066260303217499)
,p_list_item_display_sequence=>90
,p_list_item_link_text=>'Sign Out'
,p_static_id=>'sign-out'
,p_list_item_link_target=>'&LOGOUT_URL.'
,p_list_item_icon=>'fa-sign-out'
,p_list_item_disp_cond_type=>'USER_IS_NOT_PUBLIC_USER'
,p_parent_list_item_id=>wwv_flow_imp.id(3417064524503217498)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/navigation_menu
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3415215420357210816)
,p_name=>'Navigation Menu'
,p_static_id=>'navigation-menu'
,p_version_scn=>'SH256:km0bi8XlN9sY45PMQoyQcbOsgjy3W-Lx5_tYH2lfX-k'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417067183845217501)
,p_list_item_display_sequence=>10000
,p_list_item_link_text=>'Administration'
,p_static_id=>'administration'
,p_list_item_link_target=>'f?p=&APP_ID.:10000:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-user-wrench'
,p_security_scheme=>wwv_flow_imp.id(3415221434058210839)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3415249526740210911)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'Customers'
,p_static_id=>'customers'
,p_list_item_link_target=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table-search'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3415239480388210900)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Dashboard'
,p_static_id=>'dashboard'
,p_list_item_link_target=>'f?p=&APP_ID.:2:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-dashboard'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416025200906213956)
,p_list_item_display_sequence=>70
,p_list_item_link_text=>'Employees'
,p_static_id=>'employees'
,p_list_item_link_target=>'f?p=&APP_ID.:8:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table-search'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3415237921719210895)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Home'
,p_static_id=>'home'
,p_list_item_link_target=>'f?p=&APP_ID.:1:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-home'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3415799389049211379)
,p_list_item_display_sequence=>40
,p_list_item_link_text=>'Order Search'
,p_static_id=>'order-search'
,p_list_item_link_target=>'f?p=&APP_ID.:5:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-cards'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3415806613408211399)
,p_list_item_display_sequence=>50
,p_list_item_link_text=>'Orders'
,p_static_id=>'orders'
,p_list_item_link_target=>'f?p=&APP_ID.:6:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-layout-header-sidebar-left'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416023278245213952)
,p_list_item_display_sequence=>60
,p_list_item_link_text=>'Orders Calendar'
,p_static_id=>'orders-calendar'
,p_list_item_link_target=>'f?p=&APP_ID.:7:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-calendar-o'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/page_navigation
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3416789319697217167)
,p_name=>'Page Navigation'
,p_static_id=>'page-navigation'
,p_version_scn=>'SH256:_UiLkca4iZiLaWmklV7Ok7mtWRMkMRmDtN7jQ2eUBUs'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416791003995217169)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'Customers'
,p_static_id=>'customers'
,p_list_item_link_target=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table-search'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416790373640217169)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Dashboard'
,p_static_id=>'dashboard'
,p_list_item_link_target=>'f?p=&APP_ID.:2:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-dashboard'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416793653769217172)
,p_list_item_display_sequence=>70
,p_list_item_link_text=>'Employees'
,p_static_id=>'employees'
,p_list_item_link_target=>'f?p=&APP_ID.:8:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table-search'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416791628740217170)
,p_list_item_display_sequence=>40
,p_list_item_link_text=>'Order Search'
,p_static_id=>'order-search'
,p_list_item_link_target=>'f?p=&APP_ID.:5:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-cards'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416792326732217170)
,p_list_item_display_sequence=>50
,p_list_item_link_text=>'Orders'
,p_static_id=>'orders'
,p_list_item_link_target=>'f?p=&APP_ID.:6:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-layout-header-sidebar-left'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3416792968696217171)
,p_list_item_display_sequence=>60
,p_list_item_link_text=>'Orders Calendar'
,p_static_id=>'orders-calendar'
,p_list_item_link_target=>'f?p=&APP_ID.:7:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-calendar-o'
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/user_interface
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417070088960217504)
,p_name=>'User Interface'
,p_static_id=>'user-interface'
,p_required_patch=>wwv_flow_imp.id(3415219520831210834)
,p_version_scn=>'SH256:R-pmMXiW-l0wY_x2obP86PPDqqaX6VkO83PAveuG_Yg'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417070624441217505)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Theme Style Selection'
,p_static_id=>'theme-style-selection'
,p_list_item_link_target=>'f?p=&APP_ID.:10020:&APP_SESSION.::&DEBUG.:10020::'
,p_list_item_icon=>'fa-paint-brush'
,p_list_text_01=>'Set the default application look and feel'
,p_required_patch=>wwv_flow_imp.id(3415219520831210834)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/lists/user_settings
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(3417103531458217542)
,p_name=>'User Settings'
,p_static_id=>'user-settings'
,p_required_patch=>wwv_flow_imp.id(3417098503295217537)
,p_version_scn=>'SH256:OQGnb1n7GAjW62UabHIgG9OuJxcFn8bMLZXt-Fu7xMI'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(3417104248722217543)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Push Notifications'
,p_static_id=>'push-notifications'
,p_list_item_link_target=>'f?p=&APP_ID.:20010:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-bell-o'
,p_list_text_01=>'Configure whether you want to receive push notifications on this device.'
,p_list_text_02=>'<span class="a-pwaPush--state"></span>'
,p_required_patch=>wwv_flow_imp.id(3417098023305217537)
,p_list_item_current_type=>'TARGET_PAGE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/listentry
begin
null;
end;
/
prompt --application/shared_components/files/icons_app_icon_144_rounded_png
begin
wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;
wwv_flow_imp.g_varchar2_table(1) := '89504E470D0A1A0A0000000D4948445200000090000000900806000000E746E2B800000F53494441547801EC9D5B6C1CD519C7BF5DAF9D8B1DE3C44EE224181C12DB5C53836908412AA105D4AA2D1214A97D680B69AB4AA8E5852724A4125A1EFA5055AA';
wwv_flow_imp.g_varchar2_table(2) := 'AABE410CEA5B45850845AA803680440228519C1412622776509C60E7E64DE2FBDA3BFDFE67769CDDCDDA9E9D73766767E6B3F69BEBB9FECF6FCFF9F6CCD9759CE44F14D0504000D2104FA2120940428196020290967C1259001206B4141080B4E493C802';
wwv_flow_imp.g_varchar2_table(3) := '9030A0A5806780B47295C8A15140000A4D53FA531101C81FDD4393AB00149AA6F4A72202903FBA8726570128344DE94F4504207F740F4DAEE5076811E9B6BE7EACF11BAF9F6C8775EE3EB19DF73F70ACB3BBF7E9A818EA8CFAC3F858E9016D1691AFECB7';
wwv_flow_imp.g_varchar2_table(4) := '7D07A8B3FB586B6777DF8B6C7BD9ACE974E2422C9D3E0EA398F531EFDF768C28D61D15439D517F181F2B3DA04D6777EF4067F789EE4E5BB31DE4F39F2F0071E5776444B0881203ACC12E36DFC5E03204E0156B25B29EE68242337ED3012865B8C697CBFB';
wwv_flow_imp.g_varchar2_table(5) := '8A97333B06877B9A5E00B337234239B30F695E004A19F74A00A9EFC57256B42C00D9E0F4595C317ED7A0B27C24AF1228A0B4DDD5A986B9BEB2805472803ABBFBB8B7210687E4AF6C0A3820F5951CA2920194718E018FF8366503E7BA8C32BDD131F69BAE';
wwv_flow_imp.g_varchar2_table(6) := 'BB67E4424900E25E87A151CE31EF8D949388241D6F0AA037AA82B35D1227DB3840E879B8A2E8797827AFCA500010117F8031DF1319078828C1733595219B94225B01405465FC8D1DCFCE42F798872E1450862D5D214B163FC693B6278CBEC18D01C4F0C0';
wwv_flow_imp.g_varchar2_table(7) := 'E317784AD6F8A612B6D4E32053A9190388ECD95153E592744AABC08BA692370250273FE424C2184BF21708053094F51AF954660420D6CC18D19C96E997A4575801236DA60D90F43E855BA7F2AFA217EAD3F659B501228A3D45F2175405B47B2103009136';
wwv_flow_imp.g_varchar2_table(8) := 'C5247F3E2960693FE2D002C81EBE7CAABB646B4001FD614C0B2003359024FC57E0419D22680214D7CA5CA7E012D798025A2E88264069ADCC8D4950A284A291AC9E1FA409904C1E061FB258ABCEB73D3C0384AF9A045F3CA9011498A29A46ECBD98678062';
wwv_flow_imp.g_varchar2_table(9) := 'B35693970C254EB814F00C50B86488766D743A030128DAEC68D7DE334056556C9576EE92404528A0D3969E018AA567C5079AAFF92374DD334095ACD1CC689252C9F334353440D317CE10CED39363955C645FCBA6D319840A206B26459383C7199A410668';
wwv_flow_imp.g_varchar2_table(10) := '9866199A99D111753EC930012A5F5B2A8499870620F430130C4F9A216ADB78333DB2750B3DFED07DF4E8FDF7D0C35DB7D38AE5CB1454000CA085B02D7DA95228000210E8616A97241438F76D5A476BEB97536D558CD6D4D650F3CA7A7A6CDB9DB4A56D23';
wwv_flow_imp.g_varchar2_table(11) := '01B054F29C2BB1912ECC55E088060A0540D3170655F3B5B7B52970D449DE2616AFA2BB5A9AA8BEFE06F68946D8927921EC530033CD7ED3F8A9CF093D1A0CBD16FC29DCB343C9D651201400C1D701187734DFE0D4ABE01E106DBB6393BA37CBBE913AC8DA';
wwv_flow_imp.g_varchar2_table(12) := 'A4D8F10630F09BE2896AEABA651D6D6E594F0DCB6A943F3535D4CFC3E0F9AC1872187880E0FBA0195B9BEAB15BD430A461A8B366A673C2029E54729856ADA8A55F3DD245BF7F723B3DBEB59D9E7EA08D9EFBFEBDF4E4035B14480883B039918D9D042FA1';
wwv_flow_imp.g_varchar2_table(13) := 'C0033427795562EE70B1837855754E108B1D6F800178004B6B635DCE7D9C74B6ACA4E7BE778F026C76F41239E0E25EBE213DDC0768180EC33C8D10788062891AD57E6363A36AEF6673757C829C78089FCA38D54F6CBB15A7F35B3C4EF7B4DFBCA0239ECA';
wwv_flow_imp.g_varchar2_table(14) := '0C8370EA012586C369F6D1703ECDBE15E09A3F83E0DD093C408EE4E792A334366B39A7F3EE8746AEA87BD900A52747A961790D15EA7954E0ACCD8EB6D5AA17B2F28640049952734DC304FFE9D9473BE98F4FDE4F7FFFE50E7AF6BB5D74D39A4676DC4778';
wwv_flow_imp.g_varchar2_table(15) := '72B37FC1DE0BE904C9020F508C9DDDEA86B5845EE5E4E0E21FCF3F3D869F68244AD435CCB5133EDA373536CD9D2F76B07175BDEA852C1EFA9CB029EE79E0CC6F6BDB40EFFEF6DBF4CCD60DF4D8ADABA86B5D2D3D736F33FDFBD7DB0850ADAB4DA8894D27';
wwv_flow_imp.g_varchar2_table(16) := '5ED0F7F1A05700E5070C78D77F3E304827BF3E5FB0271A9B4ED1FB878E2BD0AA19B8F8D25A442507821BAA17EFBD5404DE5C4EC5787BED95E6196F0C572D8D2B68F78F3B697D5D617F0C503D715F87820FC3D9B514827B140A80D00B2D69BE45B5C2FE2F';
wwv_flow_imp.g_varchar2_table(17) := '4ED2BE435FD0FFCE5CA4E12BE3D47F6E848E7C354C6F7E7490862E8E50158353DDB05A85C5067101DFC0797B68C3B5C5AC9F214518C4C51E4E32F6BFF9CE16EC16344084E12CCDC3E682010372331400416B34262042EF32CCFED0E1637DF4DE674768DF';
wwv_flow_imp.g_varchar2_table(18) := '91E374A46F40F925B8B7A4792382E718FCA14B57C7A8E7F448CEF54227A72E8EAA1E2451B772EEB603C363EDD786C5B99B050EBED9DAA4D24873CF55E0B6974BBEC5090D40501010A17759766307D534DDC87ECE4A02344B199AA57C0DF7102EDF1016D7';
wwv_flow_imp.g_varchar2_table(19) := 'FE7BE4245D9E9CC561414B4EA468F7DE23EA5E22CF8742AFA26EB8D8AC6F58A642C1F7520701DE840A20A71D00121AB8A6690303B49A1C7FC7B99FBF477840845EE8D5FF1CA2435F5DC80F42E8795E79EF80EA390065769A1816072FB91F02ADB40D29E2';
wwv_flow_imp.g_varchar2_table(20) := '5D9751C02E041E200C03F041E094BA357C62423CC781469BA131010620FAE7FE2FE8CFEF1CA0D73EEEA3373FEBA53FEDD94FAFBC779092E3D30CE45AB6D5889263E84DCE5E4DE55C9BEFE4AD43A7D42D80AB0E02BC0934409877B127E806D51C0B26EDDC';
wwv_flow_imp.g_varchar2_table(21) := '183E31219EFDDCCB7EA88AC6C41087E10F3001A413A7CFD2C1FEAFE9CAB4A59C6FDC4398FCF6AECAF8432FBC7D98CE8ECEE4DFCE39DFF3E5253A7DF1AA1A5E736E04F424B000011ECCBB3437AEA4ED5B3AD4320EAC01726B78488A3542D33C4B8C1EC969';
wwv_flow_imp.g_varchar2_table(22) := '3F8004477B79EB9D0460B087FF846BB8E784CBDE63B84C30449FF60FD35B4787E785E8E0D763F4FC1BFB55D4EA86356A1FF44D200142833BF03C7C7707DDB266A55AC6B1B67EB9EBFDB68E9BE8AECD37CD2D34CB1ECE9C469D0F18E77EF61E40603AE0AF';
wwv_flow_imp.g_varchar2_table(23) := 'EFF6D00B7B7AE8C0D9517286B43DBD49FADDFB03F4B3573F5051E0D41793B68A54A19B400294CECCA1001E1D5D015EEDB2A52A090C67E3A73E27B7861E10BE97031E8070A611D013FD7CF787F4F05FDEA5DB5F7E879EFFC7C7F4C62747D55402E0C976C0';
wwv_flow_imp.g_varchar2_table(24) := '55E63E6E74B30E2440E87D30FCE8541E33D36FED3BAC261791CEA6F5ABC9ADE1A93DCA80E16F6AA87F6E361B10C147C2D0874F7518D6E04F55F3CC376C294F2584091EE81648805070A7E7C0B1177BFFC051F558A3ABAD855EFEC983B4F35BB7BB362CF9';
wwv_flow_imp.g_varchar2_table(25) := 'C09A21C4C5A7AF6C8850168094A86BE0B9A80D04DFA99A67BE61B817360B2C403A0D81471B78F80A001EEFB21F81149B1E9EDC232E7A2D40944A9EE34F8249D796E6596867F82B36EF4A0A1F4980C627A7541BDCDDAAF749E8143FD65009F106D30718D2';
wwv_flow_imp.g_varchar2_table(26) := 'DC5AFE34022711C85724011A1D9F508D855E441D78D8001E4C2E9E3C7B9E7EB4B543ADFDC1FA1FB786A51D2DFCF41EC0A592C15D671D49803CF0725D14C0838B5830F6874737ABB53F58FFE3D6F054BEFBA7DB0910616213431AD20B9A09401E5ACC796A';
wwv_flow_imp.g_varchar2_table(27) := '8F5E040BC63C24A1A2AC5F912040849314FB50D807C632051580324214B31B19B37DA8AD2DEE966F2C943620422F84698185C255EA3D01C843CB24C7C63DC49A3FCA8655F5F3DFACF03B0250853750A5174F00AAF416AAF0F20512203CB41C9B9854EB9D';
wwv_flow_imp.g_varchar2_table(28) := 'B1E61986471315AE75288B174C8096D6A9C71058EFECD870D2FD170B43D9923E552A900061A92A9E6A3B0F2C7DD24EB265058A07882355C20B4FB5F1C012FB4A284F54CB1058804C3458F74747C9B1BD5F0E9948327269441A203CC772CCF4DC4E54488A';
wwv_flow_imp.g_varchar2_table(29) := '34406ABD73F3F55F348C4AE39BA867A401D215F0CCE529C24279C78A49CF8983FD9922BE53564C1EE5082B0069A8FCFC1BFBD542792C96FFDB477DAE53C2577B10C7B1D317AFAAF5D2AE13A8A0800290466360BD73A2EEDA77E48B4DCA898FE9082CC82F';
wwv_flow_imp.g_varchar2_table(30) := '367E25842F234095505DB365A86E58A3D63D7B4D155F48C49C56A2AE81B08EDA6B3A7EC61380FC543F04790B402168443FAB2000F9A97E08F2168042D0887E564100F253FD10E41D1A804627A6D56F22E2771117B3B189C910345D65542108002DA814E6';
wwv_flow_imp.g_varchar2_table(31) := '52B0C00CBF8388DF447463F8562AE22C98B0DC74A540E001C2FC0926E2123CA1E7D6103EA81377AE5AB58C81020F10B4C29A204CC8B9B5448027EE50DF4AB250006442D081A14BF4E6C17E5786B0C8133F0F8C7D942DF200A1F7821F85DF443CD8779ADC';
wwv_flow_imp.g_varchar2_table(32) := '18C22678C8C4F019657850F7C8030411F01B3E5863EDD6EC1F90DA80A89137012883007A22B7263D4F4634DE851A20AE5F595E9812F8A4EF8CFA3D44FC26E2628675442818864EEC836C029081D6C3940060706BF09F309510869ECC334056BCEAFAFF07';
wwv_flow_imp.g_varchar2_table(33) := '60A03182980440801FE5D630DD90E0A98420D635BFCC9E01CA4F48CE83AB804E67E019A0D8AC7529B89249C9B315D0694BCF006517408EA3AB806780ACAA98F84021E146A72D3D031412ED0A5743AEBA56C033404B68FAA2EB5C2460452BA0D3969E01FA';
wwv_flow_imp.g_varchar2_table(34) := 'ECA9DB04A08AC6C27DE174DAD2334099E2D9FFBF287322BB202A107B4DA7D402908E7AA1889BFE50A71ABA006965AE5370896B4A8159AD514413A019FBBFC79AAA8BA45376057A76DEA6D5865A006532D722B8EC8A9534C3A025AEE7FFA0B65A002101B6';
wwv_flow_imp.g_varchar2_table(35) := '97D8E4154805ACD7758BAD0D50CFCE36F44030DDB248FCB22A609DCAB49D56AEDA00D9B9EB936CA723DB322A6064E43004103C794BCB192BA37092152BD0B3B35D6BFE8793502F2300659C692344AB52C9A6D40AEC329581118050189B687DAF1E698995';
wwv_flow_imp.g_varchar2_table(36) := '54810FD8F731F6663706905DE5140A260EB52D4631DB3285558EF3432633330A903D94CDEC34594049CBA40231E36D63142054D586C8325E50A42DA6A5C0433C74191F1D8C03842ADAFED0CC4622F964063DFC35D506258107F52A094048D8EE896631DE';
wwv_flow_imp.g_varchar2_table(37) := '1AF3F891AE58510AB0C3DCBEB1143D8F538A9201840C0011171E8E3543A4DE09B82C56720594D6BB587BBC814B9A5B4901724ACE156188D01B29DFC8F838ECE4237B071CD5EBB0E6A557A42C00A11A766FD4FE1AC3C4EF0A01099A98303B0D8063ED64DF';
wwv_flow_imp.g_varchar2_table(38) := '13C35559C0B1F3252A1B404E86D873453320C1D1A60C50312353EB483FDC065808BD38BB0504E738C67A3238661E4D50917FBE00E494D1EE95DAE0E831509BF91DD416AB89CF3459F178078CACD803303EFE217FA2E3A901F45CE137D4D7B14CFD951EDC';
wwv_flow_imp.g_varchar2_table(39) := '7B67606903382FF1394072E4F465EF2B40856A8C6F081C7E6A532FACE7179BF7C1F8F85FFC2E63C8300486DF505FC732F5577A14D2CBEF6B150790DF8248FEC529200015A79784CE534000CA13444E8B5340002A4EAFF08436541301C89090514D46008A';
wwv_flow_imp.g_varchar2_table(40) := '6ACB1BAAB7006448C8A826230045B5E50DD55B0032246454931180A2DAF286EA2D001912323AC9E4D65400CAD543CE8A5440002A5230099EABC0FF010000FFFF3E2ACDBF000000064944415403004584918A99A3A1580000000049454E44AE426082';
wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id(3415217698194210827)
,p_file_name=>'icons/app-icon-144-rounded.png'
,p_mime_type=>'image/png'
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/files/icons_app_icon_192_png
begin
wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;
wwv_flow_imp.g_varchar2_table(1) := '89504E470D0A1A0A0000000D49484452000000C0000000C0080600000052DC6C0700001000494441547801EC5D5B9054C519FE5D7691950577E50EA2801A0C1205971020159218D007AB82462B577DC09887A42A95AA541E928A6FB14CAAE2437C8E8107';
wwv_flow_imp.g_varchar2_table(2) := 'AD5CAABCC6F201256A2C65D580202266352C28B76581656577D965979DC9F90E746F33CE3067CE9C3373BAFBA3B6A7FBF4E9FEFBEFEFFFBF3EDD3D679A86659B3FCE3310035F7DA041F88F08788C0009E0B1F1D9751112805EE035022480D7E667E73D26';
wwv_flow_imp.g_varchar2_table(3) := '008D4F043805A20F788E009F009E3B80EFDD27017CF700CFFB4F0278EE00BE779F04F0D103D8678D0009A0A160C2470448001FADCE3E6B0448000D05133E224002F86875F659234002682898F00181C23E92008588F0DA2B044800AFCCCDCE1622400214';
wwv_flow_imp.g_varchar2_table(4) := '22C26BAF102001BC32373B5B880009508808AFBD42C0230278655776362202244044A058CC4D04480037EDCA5E454480048808148BB9890009E0A65DD9AB880890001181B2BA18952F89000950121ADEF0010112C0072BB38F251120014A42C31B3E2040';
wwv_flow_imp.g_varchar2_table(5) := '02F86065F6B124022440496878C30504CAF58104288710EF3B8D0009E0B479D9B972089000E510E27DA71120019C362F3B570E0112A01C42BCEF34020E13C069BBB17309214002240424C5D889000960A7DDA875420890000901493176224002D869376A';
wwv_flow_imp.g_varchar2_table(6) := '9D100224404240664A0C95898C000910192A1674110112C045ABB24F911120012243C5822E224002B86855F6293202244064A858D006042AD5D17B02E4CF8DCA68DF7139DBBD5F860F75CA99037BC21869E49D1BE81394A9145896B703016F0900A786E3';
wwv_flow_imp.g_varchar2_table(7) := '0F054E3FDA774CC686072517900166438C80BC9113870272748524411DDC677007012F09900B9C5D397E1453820C20C9D9EEF34488528765EC40C03B02604A331C4C774CF3CC6A6D91D5375D2777AF6D97FBD6AD921FDDF665B97DF5ADB2E6E6C5327B5A';
wwv_flow_imp.g_varchar2_table(8) := '9B2E0A228C0DF4864F039DC984D5087845008CFC98D2288B4DB9A259D6AFBC59D6AF582AD7CD992193273685B72E6B982033274F944533DB64DDF2C521195016371509200BD70C7623E01001CA1BC21CF931B26F58738BCC9A7A45D98A20C3BA154B64EA';
wwv_flow_imp.g_varchar2_table(9) := 'D42BC3B2200188C435410887D51FDE1060E4C4616D288CE618D9754684049E0EDF5A76BDA02E8A8304A37D3D48460E20CC28779C22E3558B82DE10E0DCC0298DE7AAA537E874250990C0AC9B1B1E905CB0A02E274339BE5A7863770904423DC408C81BE1';
wwv_flow_imp.g_varchar2_table(10) := '8E1320A969F0820058F82A54318D8932ED51E50B63D4850CE49F77DC3348960C208872FC92858C1B90C91D27039094935E10004EA8705C386FA64AC68E972E98ADEBE682A780BE28488078E6BA03B717CD6C957B56DF24BFDAB0461EFEFED7E5E1EF7E4D';
wwv_flow_imp.g_varchar2_table(11) := '7E72C74AB9F7AB37CB757367A048184004EE388550A4FAE109010634888B664CD5E9B88996C99375D5FCB9119D3613B9606A84298DCABB6ACA6479707DBB3C70DB2DB2FCDAE9D2DA7C7EC7491A1AE4DAB6665936BF4D36AE5D12920165514F9100B2705D';
wwv_flow_imp.g_varchar2_table(12) := '32F0466C041A62D7B4A8221C49A98B79BC4AC78D67344F285BD51CF931B2FFF2CE15B2605A4BD97A20034832ADAD352C0BDD41A4FC856FA9C34C7E248680170430D11A1CCB9B97B1D2F89E40558483AAB48A478C1D278CE618D9D5BD28319E0EA883BA28';
wwv_flow_imp.g_varchar2_table(13) := '8F3646B9E30428120F5E10A0A1F1C27423802F3F321C7C56F7373832AA0598B255A6B9E3F49D5537AAEC8A6290C0AC9B0BD61AB9605A554E089E14A3C156AB5A7863770904423DC408C81BE18E1320112F087059E3C4B0B3F8E8E9AF9E005DC74F435418';
wwv_flow_imp.g_varchar2_table(14) := '1A265D3CADC1C237BC117C601A1365DA13142DFA87BA90819BE71D973B4EC022C9E0050126B4B469CCBA0E57F6E595AE68248EF59CD0570D93C617C4C83447E9E58BE622ABAAF0CD25D7E8FAB9E029A02F0A12209EB9EEC0EDAF2C9A25BFBF67956CFDC5';
wwv_flow_imp.g_varchar2_table(15) := '1DB2F7A13BC3F0C483B7C91FEE5D2DAB6E9887226108C965E93B4E6107AAF8F083008693769F3C25034343B121435DC850022618B291673AE9B2ABCF2F64911F37B4B54CD255F311779CE64F9B224FFCF81BB2F9872B64C317A7C9DC298D5A46FBEC66F9';
wwv_flow_imp.g_varchar2_table(16) := 'F68D57C9A6EF2D139001657153912017619A85F2AE042F087059B00668349E02FFDAF99198F3F8A8C6C402FA95F70FE8E29009D93A2348C0918228FCC33C3E4C54F171ED959797AD6D8EFC18D9B7FC74ADB4CFB9F8C9544C08C8B0F9BE3572CDCC69E16D';
wwv_flow_imp.g_varchar2_table(17) := 'E88EB541DEA31D272F0800EB36B5CE441486FE3343B26D77674524C8E7C6A463F74772FAF467A10C7C9832715D183E1B1E2BCCAAFC3AF89E40558283AAB48A478C1D278CE618D9D5BD28319E0E9B7EB0425017E5D1C668853B4EA8676BF0860018A927CD';
wwv_flow_imp.g_varchar2_table(18) := '5EA8ED74AC6F40B66EDF2BC74E5F7A61890A3D8323B2F5DD0FC59CFA401664E2BE19CC5DA1FCD8F86E9159A69274DFD0B80C53B69261EE383D7257BBCAAE280609CCBAB960AD91F3642AE40D01E01158B036B5CE42320C7812BCFCCE6E7979FB1EE9EA39';
wwv_flow_imp.g_varchar2_table(19) := 'BF36C03407373145DA77F4B86CDDD9292F75BC2B200CF211264EBF5A200BE9C260EE381DE88DBFD65072771DEA53C9A0CDD23B4E98C64499F668610509D4850C64E32930365C7E604059DB83C50488077D53EB0CC1E86DD686736F0BA644CFBDF99E3CFB';
wwv_flow_imp.g_varchar2_table(20) := 'EADBF2E4D6B7E4D9D77748C707FB2E1AF55107751B5B4A2F6ECD1DA79DFB8FA24A55617F404225A09074E628BDE1D605AA58ECF8676BBFA0EBE682A780BE7038E11D01604B3852F3D58BC57C1A20FF520165AF58B03418852FBDB8347785F61D392E7D83';
wwv_flow_imp.g_varchar2_table(21) := 'F1BF77405DC8507A99B291673AE986C5D391555598D7DAACEBE74BEC38E9028E24BC24006C87F93B9E062002A6348DC12E919A63234680C329C74759D42B172017B254B94DAFED11731EAFF2CBC558406F7EA35317834CC8D61941025395200AFF308F0F';
wwv_flow_imp.g_varchar2_table(22) := '13557C6057A88AEA5656F59600CA5A70AAC6604A3371FA3C99143C1530CA2346B83C583447757C250F7193B1E3D4DB3F28CF74ECAD8C04B99C3CF34EA79C3C353EFF3765A28DC27064E05C615655D726B9AA1294F1CADE13200DFB8054582B28D95D3D7D';
wwv_flow_imp.g_varchar2_table(23) := 'B2E995F7E4C0C901955532FEE4D4906C7AED7D31A73E9005998595F094D279F9EA5FF23BD23F4EA28B64EB46DC4B900029D914EB8C2663C7094F82C75FDE111261D7C153E1DA00D31C348F29D2CE4F4EC8E6D7F7CA9FB7BC13EC488D8FFC989E4116CAE9';
wwv_flow_imp.g_varchar2_table(24) := '702161EE386D3FDC7F21377EF47CA7F98A474B7C4116D5749E00B9603F1B5F160D1FEA0C8F3DC4D1874904C83BDBBD5F203B5FE29B534C9F307A9BFE80A7C1536FEE96475F785BFEF8DC1BF2D0DFFF2D8F3EBF4D9EEEF8E0A2511F755017D333A48B0573';
wwv_flow_imp.g_varchar2_table(25) := 'C7E9B9F73E2D56A4A2BCFFECEBD6E54B914E177024E12C01E0947050BC26802F8B929ED3421E5E2B866CBC7A8CB6D066A15FC091B0D0369F0685650AAF51166B11D42DBC675E6391AEAEDFFAF8B01CE91FFFD24CE5478D511732547953B6CA7331769200';
wwv_flow_imp.g_varchar2_table(26) := '18F5E19470D05A190D6D9DEDEE2A7A902EE6EF781A800898D234A6B4E3B4F1C98E8004E3F3F8A87DC702FA81BFEDD0C5A11F74D6190E279C230046618CFAA6CDAE9F3F373CE6501D7D88E30FAB0D908553E520DB3C2BA81409A00F9CAAB1A555D2DA713A';
wwv_flow_imp.g_varchar2_table(27) := '78B25F7EFBC2AE8A49F0D08B7BE4D39E9350310C4DC62E5698E1F0877304183971489B0B8E09275DB5F89AF098C3247E0FAC8443168E48816C9C1584B6700F5323BC9B8F742D024885B5826AEBEDAE63B2F1C96DB2E3E8A0CA2A19EFE81E928D7FDD2EE6';
wwv_flow_imp.g_varchar2_table(28) := 'D407B220B364A53ADF48BA79A70880D11F531105121C134EAAAED38AD106DA522418ED3B56742A9456FB582B34193B4E7812DCFF97D742E7FEE77F7B8327C2A8609A83F6B1D5F9FC8727E5817FEC92FB1F7F454018E423607A065948FB129C228039F262';
wwv_flow_imp.g_varchar2_table(29) := '6A02C7AC9521D1D62CE32469AC4192D86D828CB83B4E70EE5F3FD521EB1E7B49D6FD698B2C79F84559F7D816F9CDD36F5D34EA03238CFC989E21ED53708A0038484A196FE19CEADF8D51B2CAC57873146F8DFEEFE091724563DDC7B40A4FB67AEE38C552';
wwv_flow_imp.g_varchar2_table(30) := 'DC824A4E11008EA230C788ACD269C6707EBC396AFE5620CDF6201B6428B5D8C6FCBDA9758624BDE384765D0C4E11A0D60652CE6FB6DB7EC3FCF098437DF4218E3FAC3240D683EBDB05B2CDB3824A9100FA800898D224B9E304B9AE058B08903DE8DF37DE';
wwv_flow_imp.g_varchar2_table(31) := 'F78763C249EF6E5F2438E63089DF03AB1E43168E48816C9C1584B6700F4F3C73DD833C86CA1020012AC34B97C6E86FCEF9E19870525D20A504DA405B8A04B5DE714AA95B75134B02C4847EDFD15E5D13531338A6CE483981B616CEBE4AB792E48E13769D';
wwv_flow_imp.g_varchar2_table(32) := 'CE5E78C709DFA8EB461C4D9000310DDBD3DBA76B2E5F307EE284CE4C29813747F1D6E88E8F0FA6D48284FF652C769CF08D3AC880EF57526BACCE824980980630777D3022C714535135383FDE1C357F2B50918018852FB5E314435CE6AA90009933491185';
wwv_flow_imp.g_varchar2_table(33) := '822CE5FC4152FFDDB3727178CCA179F4E1DE0B4720C68D210BA7CA41B66A088BEDB3255EF453656C8D49004B2CF7EADEF1290F0EB18293FEEEF6EBC3630E93F83DB08201B270440A64A30DB4857B2081F99E15F25C0824800556C4E86FCEF91FB92BF84E';
wwv_flow_imp.g_varchar2_table(34) := '20C2D187D5760D44405B4A0EA643AEAD07480065DD0CC73B3F197F551953133866ADD4455B3FBF7D996ECEB5631349006DDAEC260EF4F46AE5EEFAD21C9DAE5562E5FCF183C0F28E9D174402D4CA8BAA68C7DCF5C1885C85A85855CD36310D8A252466A5';
wwv_flow_imp.g_varchar2_table(35) := 'B4AB910069234CF999468004C8B479A85CDA08900069234CF999468004C8B479A85CDA08900069234CF9994620C304C8346E54CE11049C228079A02BFE938B62C111BBB11B0921E0140126B48CBF239F103E14E338024E11003F066F348E1D74DC76EC5E';
wwv_flow_imp.g_varchar2_table(36) := '0208384500E061FE081C07CC22209F81081443C0390214EBA4757954B86608900035839A0D651101122001ABE03FB9281612104D1129234002A40C30C5671B011220DBF6A17629234002240030769A5448409CD7226ADD7912A0D688B3BD4C21400264CA';
wwv_flow_imp.g_varchar2_table(37) := '1C54A6D6089000B546BCCAF6F09F5C140B558AD5D58BC9469E2A60BE6FA5F26C8E49009BAD5707DD5D7BDF8A04A88313D9DA6453EB2CC1FB56B6EA5F4CEF0C11A0987ACC2B4440ED36212EBC97F435DA30836BCE0FBC4800A0C0E02D022480B7A667C781';
wwv_flow_imp.g_varchar2_table(38) := '0009001418BC458004F0D6F4EC381020018042BD03DBAF1B022440DDA067C359408004C88215A843DD102001EA063D1BCE0202244016AC401DEA8600095037E8D93010A8772001EA6D01B65F5704BC2080F90A6FB1E312E3E429AB99B2551E637B10F082';
wwv_flow_imp.g_varchar2_table(39) := '0069BEC29BA66C7BDCC85E4DBD2000DE624CE3C844175F0FB6D795E369EE0501004DB12313CD577DE3A4412CC866B017813A12C05ED0A8B93B089000EED8923D898100091003B44B553177858A1D9718274FB567CA56798CAB438004A80EBFCFD54E7357';
wwv_flow_imp.g_varchar2_table(40) := '284DD99FEB8827192440C286C6C2983B4E09839AA23812200570CBEE382D582A95EE3A815829A8EABD4812C07B17F01B0012C06FFB7BDF7B12C06217307785707C611241C161CA56792EC62480C5564D7357284DD959829C04C892352AD4050B63DB769C';
wwv_flow_imp.g_varchar2_table(41) := '2AEC62EAC54980D4214EB701EE3855872F09501D7EAC6D39022480E506A4FAD521400254871F6B5B8E000960B901A97E7508D49000D529CADA44200D0448803450A54C6B102001AC3115154D030112200D5429D31A0448006B4C4545D34080044803D542';
wwv_flow_imp.g_varchar2_table(42) := '99BCCE2C022440664D43C56A810009500B94D94666112001326B1A2A560B0448805AA0CC363B2D60F90000012A49444154328B00099059D3B8A158D67B410264DD42D42F5504488054E1A5F0AC23400264DD42D42F5504488054E1A5F0AC23400264DD42';
wwv_flow_imp.g_varchar2_table(43) := 'D42F5504522440AA7A5338114804011220111829C4560448005B2D47BD134180044804460AB1150112C056CB51EF441020011281B140082FAD418004B0C65454340D0448803450A54C6B102001AC3115154D030112200D5429D31A0448006B4C6587A2B6';
wwv_flow_imp.g_varchar2_table(44) := '694902D86631EA9B28022440A27052986D089000B6598CFA268A000990289C14661B0224806D16A3BE892290200112D58BC288404D1020016A02331BC92A022440562D43BD6A820009501398D94856112001B26A19EA55130448802460A60C6B112001AC';
wwv_flow_imp.g_varchar2_table(45) := '351D154F02011220091429C35A0448006B4D47C593408004480245CAB0160112C05AD3654371DBB5F83F000000FFFF2900C1B400000006494441540300906988B90DC3630E0000000049454E44AE426082';
wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id(3415217977116210827)
,p_file_name=>'icons/app-icon-192.png'
,p_mime_type=>'image/png'
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/files/icons_app_icon_256_rounded_png
begin
wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;
wwv_flow_imp.g_varchar2_table(1) := '89504E470D0A1A0A0000000D49484452000001000000010008060000005C72A86600001000494441547801EC9D798C1C557EC77F73F91C9BB18D0F7CE0731863883D301C864D586C0CF963A5706D944809590CFC439295A228919288043641C93FD12A91';
wwv_flow_imp.g_varchar2_table(2) := 'B2DA3FB2302094481B2D5ABC1289088EF18604BC06C3E035067BF085EF7BB0C7C61ECF4CEFFB56F5ABAEEEA9EEE9EEAA7A55D5EF3B9AD7EF55D5AB777C5EBDEFBBEA6816FE910009584B8002606DD133E324204201E05540021613A000585CF8CCBADD04';
wwv_flow_imp.g_varchar2_table(3) := '907B0A0028D09080A504280096163CB34D0220400100051A12B0940005C0D28267B6ED26A0734F01D0246893808504280016163AB34C029A00054093A04D021612A0005858E8CCB2DD04FCB9A700F869D04D029611A0005856E0CC2E09F8095000FC34E8';
wwv_flow_imp.g_varchar2_table(4) := '2601CB0850002C2B7066D76E02A5B9A7009412E136095844800260516133AB24504A8002504A84DB246011010A804585CDACDA4D2028F71480202ADC47029610A0005852D0CC26090411A0000451E13E12B0840005C092826636ED26502EF714807264B8';
wwv_flow_imp.g_varchar2_table(5) := '9F042C2040010828E4AE973E9F06D3F3DAC11BB459F3EABE9B68B2C340979BB6519E01456DFD2E6B05A0BBF7B325DDBD7B9FECEEED7FBEBBF78B5E65BFD3DDBBF740776F7F6E7273CB059891E16BC7B4691A1DDD43931D06BADCB48DF244D976BB65ACCA';
wwv_flow_imp.g_varchar2_table(6) := '1A650EE35C03F7DBAA045608407165EF5785DF9F13693D20D2D42B222F88E49E1491FB459A9608FF1A9C8053C6AAAC51E630CE35A0AE09883F8C2B0A8D04A1525E9A2B1DCCF231B7D2F7ABD6BDFF1D29AAECA20A5FF847022504200C30AE2874AB9E60B7';
wwv_flow_imp.g_varchar2_table(7) := 'DB5BC035D4B0D74C7309854C6F162AFD5ED5BAA38517D5BA4BC3169EF02F66021004C13594EF21F43F2F0DF6D71002E056FC2F54775E577AA7E01AACA8989D640938D7D40B6EAF00C384FE866858322D006EC5EFCF77F1D1754BF61261EC3610801038D7';
wwv_flow_imp.g_varchar2_table(8) := '9AEA15F4C3A45A08C62B914C0A805BF1BD163FD305305E01F178AA09E0DA5322801EC167999C40CE9C0074AB653B7126F51C154EF5D5C1C4D94200D7628B1282FECCCD113467A588DC56BF5F75F7059332C23F124817010C0D243F47909DDE40260440B5';
wwv_flow_imp.g_varchar2_table(9) := 'FAAAABE54CF0293B5DC5CED49040310108413A7A03C5E90ADE4ABD0074F7EEC54D3A68F98373C0BD24903A021001F406FA533F2448B500E0165D71EFD613FE91400609A82141BA4520B502D0DDDBAF5A7D4CAE64B0D8996412281050228015ABC28E34B9';
wwv_flow_imp.g_varchar2_table(10) := '5229006ECB2F1CEF0BFF1A8340CE79E8CC645EAA8D2B7502A05A7E356E62CB5F6D01D25F6608A89E40BFBAB6D395DE540980AAFC68F5B9CC97AE6B84A9898E40EA4420350280757EC5598DFBD52FFF49A061096038909EFB0452230022ADBD0D5BE6CC18';
wwv_flow_imp.g_varchar2_table(11) := '097804B04418EFB5EE455585A3B90A3FB17B515D7F8C8DD0FD8F3D2E4640022920707FFE9A4F3C29890B40BEEBCF717FE29702136096008602C93F529CB80008BBFE66AF3BC6961202180A087ABE89A6A739C9D8553708DD7E982493C1B849202902180A';
wwv_flow_imp.g_varchar2_table(12) := '447AFDD79A91440540253671055469E03F09244920D13A909800B0F54FF29A63DC292290682F2031011069FA8EF08F0448000412EB05242800BCDD17254F430222B9485E27560FC94404A0DB7DC6BF9EF4F21C126840024D4BBA9D57DD99CF5A2202A0B2';
wwv_flow_imp.g_varchar2_table(13) := 'F9BC32FC270112F008E4F0E21B6FCB94C3B800743BADBFB3066A2A8F8C87043240C0E905185F12342E00224D8B857F2440024104BE19B4B39A7DF5FA49400092E9EAD40B88E79180410256F400129BF13458908C8A04EA21D0D802E08EFFEBE1C27348C0';
wwv_flow_imp.g_varchar2_table(14) := '0E02DDBD661F10323C0468363EC6B1E3B2612E1B8840CD2B6461F26E5800468D7771C2C0E1B924609E40CEE810D9B00070F9CFFC05C51849A03C016302907FF147F994F0080990802260F67E00630220D2C2EEBF2A5EFE93409404C286655000380118B6';
wwv_flow_imp.g_varchar2_table(15) := 'B078BE35048C4D961B14006B0A8F192581B0048CF5960D0A80D9D9CDB025C0F349C0060214001B4A9979CC1881EA1ACB28326550009A8CAE6F4601876190403204CCD5158302900C4AC64A025924D0F5D2E7D34CA4DB8800F4BC76F0061399611C24D028';
wwv_flow_imp.g_varchar2_table(16) := '04DA274C6A37911723026022238C83046C2210555E2900519164382490410214800C161A934C025111302200C3A323462634A282C27048206902A6EA8C1101481A26E32781462210655E280051D20C11566EF89A8C5EB91422049E4A02B513A000D4CE2C';
wwv_flow_imp.g_varchar2_table(17) := '923350E1AF0D9C96CB077739E6EB237BE4CA89038EFB8A720F9D392AC3830391C4C54048A01C010A40393231ED47C5BFAA2A3A2AFCB5819381B18CAADEC0F0E079193A73442006108A408FDC4902210950004202ACE574546454FC911ABAFA1003080584';
wwv_flow_imp.g_varchar2_table(18) := '00E2514B7CF4DB7804A2CE1105206AA265C243AB8F8AEC3F3CB7A35DEEB965B93CF28D35F2E8BABBE5F7D6DF298FDED7231B7A56C98A45F365EAC456CF3B84E0EA89FD9C27F088D01105010A401414C709E3AAEAF2FB5BFD695326CB8377AD9607EFB855';
wwv_flow_imp.g_varchar2_table(19) := '96DF305BDA274F96A92D4DD2D4DC225327B4C9BC19D3656DD78DF2D0DD6BA473E9622F7488008605EC097848E8084980021012E078A76322CF5FF9E7CD9A210FDFBB46E64E9F32DEA98E18DCBDFC0659DDB954746F00227055F504C63D991E48A00A0214';
wwv_flow_imp.g_varchar2_table(20) := '802A2085F182165B9F3F7DFA75B2E1B62EBD59B5BD7AF15C597EE322CF3F4400C2E2EDA8C181DE03E62286D42AC355D53381811B86CB9035804CC06B1C515200E2A09A0F13152DEF74AC07BA5738763D3F8E08CC9FED9D3A5C6605C1F3E073E84A8F2547';
wwv_flow_imp.g_varchar2_table(21) := '4C42622E02AB0CE899C0C00D8365484C3696A6DB17149D0D4680021063818E0C9EF3425FBD6C91607CEFEDA8C3B17C71712FA09A161B7E74A5AF264AF42E201014826A6865DF0F0520C6324465D2C12F5F38473BEBB6E74C9D209843D0018C370C404B8E';
wwv_flow_imp.g_varchar2_table(22) := '565DFBD7F6ED8BAF9707BABBE4F17B6E71561CD6AF5E2ECB7DBD0BF843DA21040803DB348D4980021053B9FA2B2726F0C2B6FE3A9973667668A7E486873C77A903151715D8BFFF8E95CBE4CF1FF975794C55FC752BE7C96D4A08EEEF9C2DEB572D948DF7';
wwv_flow_imp.g_varchar2_table(23) := 'AD923F7BF85E819F8E291344FF210C84A5B769274320AE5829003191CD0D5FF3429EDE31D3738775CC9D5178B032574600D0ED47C5D571CD9C36559E79B0471EE95E24D74D6AD1BBC7D81D93DB1C3FBFFD1BDD8273B40784E51734BD9F76F6095000622A';
wwv_flow_imp.g_varchar2_table(24) := '437FE59C3AA170434F94D1A19B1E149EBFDB8F8AFCA7DFBA4396CC6A0FF21AB86FF18CC9F2D4FA35452250CBA46350A0392588102608090CDC41FEB8CF2C010A404CBC9B5A0BDDE8DC48A1371036BADCC870C5204ABBEB8FAD5D59D17FB983E80D4004F4';
wwv_flow_imp.g_varchar2_table(25) := '70006283A5C272FE83F6A3D2233D7AF501C23474E688FB8C835A82C47E4E36069133B78F026080F5E0E5AF238BE5F4E5829834B7B68D0917DD75BD13937BB5B4FCFA3C6D43046E5FE15B79B832A80F55B451F187CE1C956A561F202C483385A03CD2388F';
wwv_flow_imp.g_varchar2_table(26) := '500062A2DB32698A17F2C98141B93454A8B8DE813A1CA7CE7DE59DD55CF2E25874ADBD83CAB17EE57CF51BEEFFF6A573BD005059C7EBBAE3382A3EEE2BF04ECC3B20588B664D139805D74DCEEF752D84AD850002E2EEE56FDC04280031116E9E34B528E4';
wwv_flow_imp.g_varchar2_table(27) := '7DC70BF704141DA861E3D2484E8E9F3CE59D511A072A9F3E78FD6CB5ECD81CBE78D10B9835A343072B23572E7BEE5207E24737DFBF1F95FD1F1E5F2B9BFFE43765D75F3C246F3D7B9F63DEFEEE7A79ED99F5F2EDB5ABC42F061082AB27F6AB158E6804D3';
wwv_flow_imp.g_varchar2_table(28) := '9F16BAC712087F858C0D937BF2045ADB67E45D22BB0E1C1154606F471D8E7D878E159DD5DA5EA8984507D4C69A0585B8D566A8FFA5730BAB18A3658601A3572E392F34F147848A8F0AFFF0CDB3647EFBD889D09E7993E56F372C95579FBC4FEEB9658577';
wwv_flow_imp.g_varchar2_table(29) := 'AA16016F071DB111A000C48656A4AD43B5C2F9F071519756E0FCA1AAAC93172ECBCEFD873DBF6D1D85AEB9DE99F32D0B36B5B4E8DDA1EDC56A5560BC4086D4E49EDFCF6B4FDF2FA8F8FE7DE5DCF3A7B5CA4B8F76C9771FEAF6BC80D7909A47F07658EA88';
wwv_flow_imp.g_varchar2_table(30) := '3BDBCD71476073F84D6A92CE5F515181771E3A59734F0095FFEDED3B3D94184BB775CCF6B6831CD74D680ADA5DD7BEAF867215CFBB36705A5061B52754FE9E1B8A8740FA5825FBD9BB16C8E37775795E46556F23A7960FBD1D74444E80021039D2E200D1';
wwv_flow_imp.g_varchar2_table(31) := '4D6FF1CD07ECEC3F20EFEFDC5BF5A4E0BEE3A7E56D5FE547E813AE5F08ABA239743EBA9587DCC88817977F7953EFC4E49D76FFF1865F937A2ABF3EFFEF1E5AE1CD094054AE0D14E63CB41FDAD111A00044C7323024F4025061D16A6B0F27CE9E974DEFED';
wwv_flow_imp.g_varchar2_table(32) := '945FEC3B2E68DD4BE70672A323828ABFE9BD4FE4FD4FF7E9D31C7BD2BCA5523AF9E71C503FFE5581F3172EAA3DD1FC1F3C557E02B374E5E10FD7DE183AD2C7EE59E585815E80B74147E404280091231D1B204460E2BC65D2EA9B1444EBD67FE090D3BA6F';
wwv_flow_imp.g_varchar2_table(33) := '7AF72325089FC8CFB67F263F7DF743F9B72D1F3815FFA2EFFE010848A5CA8F585B7C4B8FFB8E9D9681AFC3CFA47F7565441016C287692D99781C55937FD80FB376E51258A1CDB377CCF3C200277F1CDE010B1C26B24801304159C50111685393826D0193';
wwv_flow_imp.g_varchar2_table(34) := '77B8C851D92F5CF84A2E5D1D7BA75F8B1A424040CAB5FC2A78E7BFB47BFED181E0B70E3B9EABFCD9B1FF7891CFD2348CAA71BAF670E79259DA19DABE714E21AC4A4B8FA123B23C000A80C10BC01581D9327961975A21982BA8D8E5A2478B0FB180DF89AA';
wwv_flow_imp.g_varchar2_table(35) := 'DB8F73CBF9D5FBE107C30DBDBD75F7973270E98ADEACD9C6B95B76168620484FA540EE9CDF5EE9704DC7EE5C547E89B3A680E8B922010A40453CF11C4445C52C3E2AF6642506E8DAA3E2C2C0ED18B51F7EE0B796544054201E38073D8B97B7EEAA6B2880';
wwv_flow_imp.g_varchar2_table(36) := 'E1C3F7FFEB2304E319A4C7DBC83B1047DE294D4DD1AD3C484BE1BE819C6F7953C7453B1A0214806838D61D4A935A2A44B71A636B18B861EA0D10E1B5FA8619E72E5E9297B77C5293086005E1476F7F58B4B407510A4A93169BA06361F61DBD70D53BBD74';
wwv_flow_imp.g_varchar2_table(37) := '68E31D686087A9AC51004C9136180F84C4DF5D87087CFFCD0FE48DBEC395856074D4F1F3AF6F6D9781CB85978D20AC72A2E4AF9C4706EA1F6E94E2397AFAACB70BA2E66DD01129010A40A438C7068665B2A8CDA89A79CF8D73834C5BC76C679E41A7085D';
wwv_flow_imp.g_varchar2_table(38) := 'F50F3FDF2FFFB8E93DA747B065F711D9DA7F5A3E3E7446DEF9FC84F4FEEF6E79EE3FDE15F8D1E7C046E54758700719FFD2E3A69D853B1583FC56BBEFD8E0B01C3E5B58C6C4B0A6DA73E9AF36021480DA7855E51B151E8FB7E279F7A133EEF3EF51DA78E0';
wwv_flow_imp.g_varchar2_table(39) := '064FDC217CC4554E0C5071D1752FEDA6EF3F352098DCDBBC63B7BCFEFEA7F23F7D7B8A96FA90499C83731106B6CB9916DFD2E3B6FEA372EC62F8A5C73776153FF3C01E4039FAE1F75300C233F44240CB8C8A8FCA8E16D73B10A30371410C200441D1A0EB';
wwv_flow_imp.g_varchar2_table(40) := '8E2544B4E441C74BF7A1E2C3EF24350989734B8F976E6308D0A29629F5FE1FFE5F61D540EFABC53E767158FE65F32FBD5390166FC31287C96C520022A2ED54FE13078A26CE74D078936F94069F16D3616B1B42706DE0B4DE2CB2D182A225D72B0EA854AD';
wwv_flow_imp.g_varchar2_table(41) := 'ED339C6548545EB8B10F2D3E2A3EFC160550610361B7A8B0B497D777EC931F6E3FAA376BB69FFBCF5D45E7D49296A213B95115010A4055982A7B42171CDD72BF2F54787CE8F3F737AC75BE06842F024565F06931848B4F86F9C500F7E4971301A40D9515';
wwv_flow_imp.g_varchar2_table(42) := 'AD3A2AD584EB1708962161E0C63E1C83BF5A0D4404469FF7832D9FCAA6CF0A93787AFF78F6BC5716B800000D5849444154533FEE130C23B43F089276D38E8700052002AE687DFDC1DCBBBACBA9F45327B4F97747EEC6D78236DCB14A4A45008214796415';
wwv_flow_imp.g_varchar2_table(43) := '0284B0E01E060C1FE00DC39FBF7C7D9BFCCDE6036A4E60EC9D8DF0E3373B8E5F928DFFFE6151E587A0D42B48FEB0E9AE4C80025099CFB84751D9F0792DED11ADF2B23933F466EC3644A65404CACD07C499188800E61AB40820AE9F6CDB2D0FFD608BFCF5';
wwv_flow_imp.g_varchar2_table(44) := '7F7F211F1E1B74C40033FC3886B13E7A09A8F84FBCB4557EB1BF70DB322A3F7A26F0679B319D5F0A4048E2FECA869618AD72C8206B3E1D22B074C13CEF3C0C05B04210A5B9AAE63760905F889E1799CF112402E80DBCBE7D8FFCC1CB3F970DFFFC966CF8';
wwv_flow_imp.g_varchar2_table(45) := 'A7B764D58B6F0ADCE825F82B3E82C25C042B3F4898311480909C477D0FC3F82B61C8606B3A1D2F19C17B066A3AA946CFE8E5C060B8835587A1334703DFDBA7450015B99628D073C0981F7311B59C47BFE1085000C2F113540A1D44FBE4C2B700F4BE386D';
wwv_flow_imp.g_varchar2_table(46) := 'BC6978F3C77B24EECA1F9407BCF577E8CC91B222808A8C5507CC0D609521280C547A08052A3E561F38E60FA214EF3E0A40847CA74E9A186168E307F5FEA7FB052F17F1FBECE95C24DFFEC66AE75360CF3CD813A98DB0F1A5211D1FC4AF9C08C00F7A03AD';
wwv_flow_imp.g_varchar2_table(47) := 'ED1D825586294B6E759E828428C0601B951E42C18A0F5A2249FC520092A01E419CDBF67C5954F997CF9F2D2FFEEE37E5D19E65D2BD6886E08320511B848DCF8C4108741620029817D0DB956C08823695FCF1983902140073AC238B095DFF2F0E176E977D';
wwv_flow_imp.g_varchar2_table(48) := 'A0BB4B36DE57788D566411950908428038F5614C3A969B18D47E68A7930005209DE5523155FE8F8CA04BBE6EE5BC8AFEE338883811B70EFBDAC02919521383519A6B03A765B48A079F741A68D74E8002503BB3C4CFF04FFADDB67C6122E939787650664C';
wwv_flow_imp.g_varchar2_table(49) := '2B7CFE0C9382511BF42C708765A5558744321F43A449054901488A7C9DF1A2FBEF3F75E9EC76FFA611371E1DFED1DB3BC63C411867E410170841B5F30D71A6A591C2A60064BC3431D167320BA8FCFEB704EBB8F1418F28CDDACE05CE474417CD9AA6A370';
wwv_flow_imp.g_varchar2_table(50) := 'EC21B5F488A181B3C19FD0042800A1119A0D60F04AF8E7EDEB4DF14F77EC2F6AF55139F115A0DDCF7D4BF0418F28CDCBBFD3ED7C4414DF1684B0202E9D6E0C0D38E9A86984B32900E1F85973365E12BAA3FFB0975FB4D0A89C61BE02E405368E03C2F2F7';
wwv_flow_imp.g_varchar2_table(51) := '8FF4383D02ED153D01EDCEBA9D64FA290049D2CF50DC1F1F2A3CDE8BD6182DB4C9E443681EE959EE4559CBFD07DE49748C2140011883843B8208E0B5617AFF1FADBB553B8DDAF87828C447478A2542EDA65D1F010A407DDCAC3A0BDD7F7F867F6BE54CFF';
wwv_flow_imp.g_varchar2_table(52) := 'A651B7BF1730EA7B10CB68221A28320A400315665C59397866D00BDADF027B3B0D3AEEF27D31088F1A1B8C3A96A8920E9402907409642CFE0533A7672CC54C6E250214804A74788C041A9C0005A0C10B98D923814A04280095E8F01809C448200D415300';
wwv_flow_imp.g_varchar2_table(53) := 'D2500A4C030924448002901078464B026920400108590A78AF9D0EE297FB0E0BDED4536AF69F3AAFBDD026815411A00044581C783F1FDED4536A4E9D2F7CE936C2E818548609A425E91480902551FA318C90C1F17412304A80021012375E72091168EB98';
wwv_flow_imp.g_varchar2_table(54) := '2BADED333CE31F1A848C82A793406C04280011A08508E0F5D678FDB536CD93CCBFA92782AC3008CB0850002C2B7066377902694A0105204DA551475AF072CE2053FA045F1D41F3140B085000325EC878396790F13FC197F12C32F93112A000C408974193';
wwv_flow_imp.g_varchar2_table(55) := '40DA095000D25E424C5F4311485B662800692B911AD33365C9ADA24DCBA4A9359E4DEFB613A000D87E0530FF5613A000585DFCCCBCED042800B65F0135E6FFE8B90BF2D48FFB02CD8EE3976A0CADBCF79F7D7E2E308EBF7A63877752D6EEB6F4129E2207';
wwv_flow_imp.g_varchar2_table(56) := '052045859185A41C3E7B51B6F51F0D3451A6FF832FCF05C681F8753CBCDB5293A8DFA600D4CF8E67264800139EB8ED3AC1243444D41480862846739940B77BC2F50B451B1331BB95BD1027E29E386FA989A81B3E0E0A40C31771B4196C6A9D20ADED1D9E';
wwv_flow_imp.g_varchar2_table(57) := '8936F4E0D04AE344FCC13ED3BB37AD29A300A4B564982E1230408002600032A32081B412A000A4B564982E1230408002600032A3B09B409A734F014873E9306D241033010A40CC80193C09A499000520CDA5C3B49140CC042800310366F07613487BEE29';
wwv_flow_imp.g_varchar2_table(58) := '00692F21A68F046224400188112E832681B413A000A4BD84983E12889100052046B83AE89367CFCBE68FF74462B6EDEAD7C10A1ECCF136E8481D812C24880210532935FBDECF77F1F2D772428940140661E924F379784D8276BD042800F5921BE73C3CB1';
wwv_flow_imp.g_varchar2_table(59) := '86EF058EE3ADEEC3EE23B20BEA3E9F27920008500040212683EF054E9AB7D47B761ECFB14765F83C7C4C856659B01480980B1C4301F406A23631279BC187249095D32900592929A693046220400188016A1A823C70EABCF41D8EC620AC34E48969889E00';
wwv_flow_imp.g_varchar2_table(60) := '05207AA68985885767E9C877F41F969FFCFFCE480CC2D2E172E54193680C9B02D018E5E8E4A2AD634EECF706602EC3898C3F650964E90005204BA5354E5A9B5ADB64E2BC658225C2A84D6BFB0C99BCB04B10C738C9E0E10C11A00064A8B0AA492A2A2896';
wwv_flow_imp.g_varchar2_table(61) := '08A33678073FC2AE260DF4931D021480EC9415534A029113A000448E9401DA4C206B79A70064ADC452965EFF03494FBCB45556BDF86624E6F5ED7BBC9CFA5737BC9D74444280021009467B0369699F197BE65BDB3B628FC3D6082800B6967C44F9C6F30E';
wwv_flow_imp.g_varchar2_table(62) := 'AD6A8520A2E0C60483672938F938064B643B280091A1B43720AC104C5972ABA0B24665B0E48830F12C4556C866319D14802C965A4AD38CCA1A9561AB6FA6908D08406B73CB4533D9612C244002B510302200B524887E498004444C359ACD844D0224109E';
wwv_flow_imp.g_varchar2_table(63) := '405643A00064B5E4986E128880801101181CBA3218415A1904095843C0549D312200D6941A334A021923604400F63CBD92AB0019BB3098DCEA09C4E1D3549D3122002EA0DC41D7E62F0990406502E6EA8A410168A200542E751E25813C017375C5A000E4';
wwv_flow_imp.g_varchar2_table(64) := 'F3468B0448601C028D29005BC7C9350F9340E608643DC1267B003FCF3A2CA69F04CC10183556570C0AC030E700CC5C3D8C25F304468CF5960D0A40E64B851920012304FA36DE6CACB1342600F94C1953362325C548AC261053E68DD6116302E0C23237BB';
wwv_flow_imp.g_varchar2_table(65) := 'E9C6C75F12C81A01B375C4B000E45ECD5A7130BD24609680B90940E4CBB000702210D06948A03C0173138048835101E03C0090D334028178F2D0F44ABE8EC4137C40A84605201FBFD1498E7C9CB448200304CC3D03A061242100C66E72D099A44D021921';
wwv_flow_imp.g_varchar2_table(66) := '60BC6E181780BE8D9DE801C064A44C984C1230412077305F374C44E6C5615C00DC98B91AE072E06F1609C494E6EFC5146EC560131200B3339D1509F02009A482403275221101C8CF747218908A0B8F89489E80F9D97F9DE74404201F79225D9E7CDCB448';
wwv_flow_imp.g_varchar2_table(67) := '204504921B12272600F9090FF6025274193229E31388C1C7D67C5D8821E8F1834C4C00DCA40D6F746DFE9280B50412ED09272A009C0BB0F6A267C61D0218FB3BCBE2CE56123F890A809B61F6025C0EFCB58FC0B5445B7FF04E5C00DC5E408E430194064D';
wwv_flow_imp.g_varchar2_table(68) := 'AA09449CB817DC6B3FE2506B0C2E7101407AFB36DEF48AB23921A820F0DF0A0298F84BBCF507E95408001222C2A180CB81BF8D4F203DD77A6A04C0ED0E7128D0F817BFF5395CE75EEBE9E0901A01008EFC50E005B86948204D04A2494B6E63926BFE4179';
wwv_flow_imp.g_varchar2_table(69) := '48950020810A10C6461401C0A069200258F273E6BA5295A7D409804B6718EF0EA408B830F89B7D026AD26F452A57BA522900EE18892290FDEB9E391041CBDFB94E52FA974A01002B88008703204193348110F1ABB5FE74B6FC3A4FA915009D405704B83A';
wwv_flow_imp.g_varchar2_table(70) := 'A079D0CE0C0135DBDF89F9AC542738F502007AEEEAC0F052E5E6CD420A02FF534D405DA3C34B55C3A5EC54A7D3495C26040029CD0F093096E2E42080D0A49180EAF277AA96DFDCB7FDC242C88C00E88C2A6555DD2AF4069A70FBB0DE4D9B0462215065A0';
wwv_flow_imp.g_varchar2_table(71) := 'AAB5775A7D756D5679464ABC654E00C0CDED0D60728542001E348911D0153F53ADBE9F56260540678042A049D0364BC0E97DAA4A9FADEE7E10A34C0B80CE50B11008E60894320BFF48204202CE577B30C66FEADBB82275B7F4D69BD18610009D7957083A';
wwv_flow_imp.g_varchar2_table(72) := 'BFD7B7B1534D166278201403E15FBD0444DC4AAFCE57ADFD4D98D9CFDC185FA5BDE27F4309803FA763C500F712385D37F60EFCA0E8F611F02A7CBEA5772BBD6A501AF69A695801F095AAB86270D32B7D6ED72DDF3B400F418B821606E702F09F4A77C311';
wwv_flow_imp.g_varchar2_table(73) := '70CA585568A7CCD14384512D7CA7EADA7B15BEE15AFA72C56885009466DE15849B0FE2062357149C319DBA089C0BA0E9EBD191E9302DAD6DF3B5C9353777D16487812E376DF76D44058771CA5895B553E6182EC2284128BD4AECD8B65200C62BDA3D4FAF';
wwv_flow_imp.g_varchar2_table(74) := 'BC08B3E38925C7B5F9E43BCBF7D26487812E376D8F57E6A5C76DD9A600D852D2CC27090410A0000440E12E12B0850005C09692663E492080000520000A77D94DC0A6DC53006C2A6DE695044A0850004A807093046C224001B0A9B4995712282140012801';
wwv_flow_imp.g_varchar2_table(75) := 'C24DBB09D8967B0A806D25CEFC92808F0005C007834E12B08D0005C0B612677E49C0478002E08341A7DD046CCC3D05C0C652679E49204F80029007418B046C244001B0B1D4996712C813A000E441D0B29B80ADB9A700D85AF2CC3709280214000581FF24';
wwv_flow_imp.g_varchar2_table(76) := '602B010A80AD25CF7C93802240015010F86F37019B734F01B0B9F49977EB095000ACBF0408C0660214009B4B9F79B79E0005C0FA4BC06E00B6E7FE57000000FFFF3E51706E0000000649444154030055AFDBC4665094DE0000000049454E44AE426082';
wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id(3415218202372210831)
,p_file_name=>'icons/app-icon-256-rounded.png'
,p_mime_type=>'image/png'
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/files/icons_app_icon_32_png
begin
wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;
wwv_flow_imp.g_varchar2_table(1) := '89504E470D0A1A0A0000000D4948445200000020000000200806000000737A7AF40000022A494441547801EC94CB6B135114C6BF4C674A496228F19550106B3056412958DA8DD08DA08808BA71E1C24D9782FF8116DDBA70E74AA42B77822E5C094610A4';
wwv_flow_imp.g_varchar2_table(2) := '22485F34F4411368FA4E336D1E4C9BA469CF814C3B935BE6320C14CA04BEC9FD0EE79CFB9B337746E9FD34DB38492938E19F0FE04FC09F80F4046A251D5D8122DA2B9B9EBEB85200B4F9836B67319088A33F11C39E51665D57F20C15C18E6B2845A65251';
wwv_flow_imp.g_varchar2_table(3) := '35332DA8D4791D511B78DC9FC4F381CBE8D20C8E31686C0F17EA5BEC652E72001D21FC5AD0313ABF8CD4EC3A94037F297C581A68D3409B7F7F76036FEE76E3EDBDAB3C21CF00A879A96220533050DEAD73F3A99286917F398C8C6630A93770744AF1902A';
wwv_flow_imp.g_varchar2_table(4) := 'B337E71CDE06DBD64BA356C5E095289EF6759B4A9E01AAFA1A321B4586AA1B1504D4760C7D9BC3AB1F0B18FA32CD536AEDD61A7104A0BBBF18095A2A0BDBDB187E780BAFEFF7B05E0E26102CAF225728E36B3A8F5C7197A764293AC6380288EA92F17396';
wwv_flow_imp.g_varchar2_table(5) := 'F0FF6C1EEF9FF462EC459FA9E13B313E17964481710520E883DBF19025FCA8270A7A7C96A0C03802A8E14E7CFE3D2128F526E4081038F806281D61CB6EA9F4227EA6572C31B7C61140D4D80E443937DFA5E8CF1479ADF3BCE98F5BB8021035B343D9BDA8';
wwv_flow_imp.g_varchar2_table(6) := '86625200F418C6B3AB688A3C157B2129003A8873D5109A229FCD17F91CD059A0B55B18290051F3A5B628FEE81A8BD634950F7F73688ABCA8CE1E730D606F4453F938534353E4ED3922EF1980A8B94CCC07F02770FA27E0F426EC030000FFFF22F8F82900';
wwv_flow_imp.g_varchar2_table(7) := '000006494441540300DE0110706BECAC9E0000000049454E44AE426082';
wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id(3415217392245210826)
,p_file_name=>'icons/app-icon-32.png'
,p_mime_type=>'image/png'
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/files/icons_app_icon_512_png
begin
wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;
wwv_flow_imp.g_varchar2_table(1) := '89504E470D0A1A0A0000000D4948445200000200000002000806000000F478D4FA00001000494441547801ECDD6B909CD59DDFF183D4A3EB0846423774018D4016C6B210480601596C6381937262832FBB9BC49B8A2F952A27716DB2E5546D2A545E6429';
wwv_flow_imp.g_varchar2_table(2) := 'C755D96C2595DDCD9B5DA8649D2A676317C61527712CE3CBC6808D31AC02C45A4A1A30921809210DD6488CAE93FEF5A8A59956CF73CED3FD5CCEE5BBE5A6BB9FEBF97FCEACCEEFB974F79C6D8FBD32C90303FE06F81BE06F80BF01FE06D2FA1B9863F83F';
wwv_flow_imp.g_varchar2_table(3) := '04104000010410484CC0180240725D4EC10820800002081000F81B40000104104020390115CC190029F04000010410402031010240621D4EB90820800002A90B4CD54F009872E0BF0820800002082425400048AABB29160104104020758176FD0480B604';
wwv_flow_imp.g_varchar2_table(4) := 'CF0820800002082424400048A8B3291501041040207581CBF513002E5BF00A01041040008164040800C97435852280000208A42E30BD7E02C0740D5E2380000208209088000120918EA64C0410400081D40566D64F0098E9C13B04104000010492102000';
wwv_flow_imp.g_varchar2_table(5) := '24D1CD14890002082090BA4067FD04804E11DE2380000208209080000120814EA6440410400081D405AEAC9F0070A50953104000010410885E8000107D1753200208208040EA02DDEA27007453611A020820800002910B100022EF60CA4300010410485D';
wwv_flow_imp.g_varchar2_table(6) := 'A07BFD0480EE2E4C450001041040206A010240D4DD4B710820800002A90BCC563F01603619A623800002082010B1000120E2CEA5340410400081D40566AF9F0030BB0D7310400001041088568000106DD752180208208040EA0259F51300B27498870002';
wwv_flow_imp.g_varchar2_table(7) := '08208040A4020480483B96B210400001045217C8AE9F0090EDC35C041040000104A214200044D9AD14850002082090BA80AD7E02804D88F90820800002084428400088B0532909010410402075017BFD0400BB114B208000020820109D000120BA2EA520';
wwv_flow_imp.g_varchar2_table(8) := '0410400081D4055CEA2700B828B10C0208208000029109100022EB50CA4100010410485DC0AD7E02809B134B2180000208201095000120AAEEA4180410400081D4055CEB2700B84AB11C0208208000021109100022EA4C4A4100010410485DC0BD7E0280';
wwv_flow_imp.g_varchar2_table(9) := 'BB154B228000020820108D0001209AAEA4100410400081D405F2D44F00C8A3C5B20820800002084422400088A4232903010410402075817CF51300F279B13402082080000251081000A2E8468A4000010410485D206FFD0480BC622C8F00020820804004';
wwv_flow_imp.g_varchar2_table(10) := '020480083A911210400001045217C85F3F0120BF196B20800002082010BC000120F82EA4000410400081D4057AA99F00D08B1AEB20800002082010B8000120F00EA4F90820800002A90BF4563F01A03737D64200010410402068010240D0DD47E3114000';
wwv_flow_imp.g_varchar2_table(11) := '01045217E8B57E0240AF72AC87000208208040C0020480803B8FA62380000208A42ED07BFD0480DEED581301041040008160050800C1761D0D4700010410485DA09FFA0900FDE8B12E020820800002810A100002ED389A8D0002082090BA407FF51300FA';
wwv_flow_imp.g_varchar2_table(12) := 'F3636D0410400001048214200004D96D341A010410402075817EEB2700F42BC8FA0820800002080428400008B0D368320208208040EA02FDD74F00E8DF902D208000020820109C000120B82EA3C10820800002A90B14513F01A00845B681000208208040';
wwv_flow_imp.g_varchar2_table(13) := '60020480C03A8CE62280000208A42E504CFD0480621CD90A0208208000024109100082EA2E1A8B0002082090BA4051F513008A92643B0820800002080424400008A8B3682A0208208040EA02C5D54F0028CE922D218000020820108C00012098AEA2A108';
wwv_flow_imp.g_varchar2_table(14) := '20800002A90B14593F01A0484DB68500020820804020020480403A8A662280000208A42E506CFD0480623DD91A0208208000024108100082E8261A890002082090BA40D1F513008A16657B0820800002080420400008A09368220208208040EA02C5D74F';
wwv_flow_imp.g_varchar2_table(15) := '0028DE942D228000020820E0BD0001C0FB2EA2810820800002A90B94513F01A00C55B689000208208080E7020400CF3B88E62180000208A42E504EFD0480725CD92A0208208000025E0B1000BCEE1E1A870002082090BA4059F51300CA9265BB08208000';
wwv_flow_imp.g_varchar2_table(16) := '0208782C4000F0B873681A0208208040EA02E5D54F0028CF962D238000020820E0AD0001C0DBAEA1610820800002A90B94593F01A04C5DB68D000208208080A70204004F3B86662180000208A42E506EFD0480727DD93A0208208000025E0A1000BCEC16';
wwv_flow_imp.g_varchar2_table(17) := '1A850002082090BA40D9F51300CA1666FB08208000020878284000F0B05368120208208040EA02E5D74F0028DF983D208000020820E09D0001C0BB2EA1410820800002A90B54513F01A00A65F68100020820808067020400CF3A84E62080000208A42E50';
wwv_flow_imp.g_varchar2_table(18) := '4DFD04806A9CD90B0208208000025E091000BCEA0E1A830002082090BA4055F51300AA92663F08208000020878244000F0A833680A0208208040EA02D5D54F00A8CE9A3D218000020820E08D0001C09BAEA0210820800002A90B54593F01A04A6DF68500';
wwv_flow_imp.g_varchar2_table(19) := '0208208080270204004F3A82662080000208A42E506DFD04806ABDD91B0208208000025E081000BCE8061A810002082090BA40D5F51300AA16677F08208000020878204000F0A01368020208208040EA02D5D74F00A8DE9C3D22800002082050BB0001A0';
wwv_flow_imp.g_varchar2_table(20) := 'F62EA0010820800002A90BD4513F01A00E75F689000208208040CD0204809A3B80DD2380000208A42E504FFD04807ADCD92B020820800002B50A10006AE567E70820800002A90BD4553F01A02E79F68B0002082080408D0204801AF1D9350208208040EA';
wwv_flow_imp.g_varchar2_table(21) := '02F5D54F00A8CF9E3D238000020820509B0001A0367A768C0002082090BA409DF51300EAD467DF082080000208D4244000A8099EDD2280000208A42E506FFD04807AFDD93B020820800002B50810006A6167A70820800002A90BD45D3F01A0EE1E60FF7D';
wwv_flow_imp.g_varchar2_table(22) := '0B4C9E3B6BCE8EBDD97A9C397AD09C1E1D311307F69A53AFBED87AD66B4DD33C3DB4EC8589937DEF970D20800002210B100042EEBD44DBDE1EF035A86B907FA739D89F1D3BDC0C0087CDB9F1E3E67C7370BFD00C05E2D1B31E9AA6797A68D9898B214181';
wwv_flow_imp.g_varchar2_table(23) := 'E0DCF8982110488B070208542750FF9E0800F5F7012D7014D091BB8EE6DB03BE0675C755BB2EA660A04070E6E801D30E04DA47D78599880002084426400088AC43632C4747E71AF8CF368FF235689755A3B6AD7D4CEDEBCDB276C37611400001E3030101';
wwv_flow_imp.g_varchar2_table(24) := 'C0875EA00D5D05DA03BF8ECE3538775DA88489DA573B08E8F24009BB609308208040ED020480DABB8006740AE81ABFAEEF573DF077B64341A07579E0C05EA33675CEE73D020820D09B801F6B1100FCE8075A71514003ADAEF1F77B7DFFE2E60A79521038';
wwv_flow_imp.g_varchar2_table(25) := '3DBA9F105088261B4100015F040800BEF404ED68DD89AFC1DF478A7608E026411F7B8736211096802FAD2500F8D21389B74303AB4EF9F7CAB071E590B9EB3D379ABBB76E36F7DFB1D53C74EF76F3E95D3BCDDFBDEF7DADD79AB66BFB2DE6D6776F32ABAF';
wwv_flow_imp.g_varchar2_table(26) := '5D6A16CF6FE4DE954280EE0D505B73AFCC0A0820808067020400CF3A24C5E69C1E1D697D863F6FED9B866F30F7DCF69ED6407FF7D69BCD8DD7AD301B572E35ABAE5E6416CF1B686DEEAA39735BAF356DF5D2ABCD7BD75E6B76DDB6D93C78CF6D4681E0A6';
wwv_flow_imp.g_varchar2_table(27) := 'F56B4CDE30A01070E6E8C1D6F6F90F020820904FC09FA5E7F8D3145A92A2808EA6F35EEFD7C0FFD007EF3477DE789D19BE76494F6C0A060A043B375F6F1EB8F356A36DE60902FAFE00B5BDA79DB312020820E0810001C0834E48B509FA989F8EA65DEBD7';
wwv_flow_imp.g_varchar2_table(28) := '20DD1EF817CFBDCA7535EB723A5BA030913708A8ED84002B2F0B2080C034019F5E12007CEA8D84DAA2C1DFF59AFF92450B5BD7F535481739F07772B783C03DB76F35DA67E7FC6EEFCF8F1F6BDDBCD86D1ED3104000019F0508003EF74EA46DD347FDCE1C';
wwv_flow_imp.g_varchar2_table(29) := '3DE054DDAAA141B3EBCEADADEBFA4E2B14B0D0CAC5F3CCAE1DB7388500DD18A85A545301BB6613082010B5805FC51100FCEA8F245AA3015303A7AD58DDAD7FFF8E2DA6CCA3FED9DAA0B3011FDDB9A5756FC06CCBB4A7AB96D3A3FBDB6F79460001048210';
wwv_flow_imp.g_varchar2_table(30) := '200004D14DF134525FADEB72D39F067FDDAD5F67E5BA5150971DB66E1AB6364321409735AC0BB2000208242BE05BE10400DF7A24F2F69C1F3F6EADF0EAABAF697D54CFBA60450BBC77FD72A336D976A7331BB665EA98AFCB13BA59518F33470F9AD3A323';
wwv_flow_imp.g_varchar2_table(31) := '463F7874EAD5175BCF7AAD699AA7879623CCD4D153EC13816A050800D57A27BD3797A37FDD7CF7B776BCCB2B279D09F8D0B69BACF704E82C806AACBBF1ED015F83BA06797DBBE2D427160E1B7D7C516760D456B553CF7A689AE6E9A1657583A682810281';
wwv_flow_imp.g_varchar2_table(32) := '6A2210488B0702FD08F8B72E01C0BF3E89B645E7C60E5B6BDBB96593D1806B5DB0E205744FC05DB7BEDBFAA5412E3596D5741DB96BD06E0FF81AD4FBD997828102C199A3074C3B10681FFD6C93751140C01F0102803F7D11754B5A4791E7CE66D6B875E3';
wwv_flow_imp.g_varchar2_table(33) := 'FA4AEFF6CF6C4C9799FA74C08D6BAFEB32E7F2A4A94173ECF2840A5EE9E85C03BF8EDCB5FFB276A96D6B1F53FB7AB3ACDDB05D04A214F0B12802808FBD12619B5C8E8CDFBB61B5F795DFB86EA5376701DA03BF8ECE35385785A77DB58380825D55FB653F';
wwv_flow_imp.g_varchar2_table(34) := '082050AC0001A0584FB6368B80068D5966B526EBE8DFC753FFADC64DFB8F2E05B89C05D0E03C6DB5425FEA1ABFAEEF573DF07716A13E6D5D1E38B0979F4AEEC4E13D023304FC7C4300F0B35FA26A95CB51620847FFED4E71390B707EE2547BF1429F35F8';
wwv_flow_imp.g_varchar2_table(35) := 'EB1A7FBFD7F78B6C9482C0E9D1FD84802251D91602150810002A404E7D17B6A3E1508EFEDBFDA8B3006BD6AC6DBFEDFA7C6162BCEBF47E265E98386934F8F7B38DB2D66D8780B363DC1B509631DB0D57C0D79613007CED9988DAA53BC9B3CA59B9B4B75F';
wwv_flow_imp.g_varchar2_table(36) := 'F4CBDA66D9F3560E0D66EE62F2DC99CCF979676A60D529FFBCEBB597BFFD86E5E61377BDC77CF29EADE6F3F76F375FFAD8DDE691DF7CBF79E4D77FADF55AD33EF7A16D66D7F65BCC8D6B5698A145F3DAAB3A3F2B04E8DE00B5D5792516440081DA040800';
wwv_flow_imp.g_varchar2_table(37) := 'B5D1A7B16397D3FFFA59DED034362C5D947933A006431DB11751D7E9D111A38135EFB676DCBCD17CEADEDB5B03FDC79B83FF6DCD10B06DFD52B3E1DA4133B470606A7373E6B45E6BDAF08A6BCC0736AD309FB9F716F3A5BF79A75120D8BE69BDC91B06D4';
wwv_flow_imp.g_varchar2_table(38) := 'D633470F4E6D9FFF2290BC80BF0004007FFB268A964D5A3EFA77CDB2E541D6A91B16970C669FB928E23E001D4DE7BDDEAF81FF9F3DF8D7CC83DBD69B5BD764B77156FC663050207868FBC6E619831D46DBCC130474D6476D9F75FBCC400081DA050800B5';
wwv_flow_imp.g_varchar2_table(39) := '7741DC0D98B49C0ADFB06A69B0002B970D65B6DD567BE6CACD993A83A0A3E9E64BA7FF69906E0FFCD72C98EBB48ECB423A5BA030F1F9FBF30501B59D10E022CC32310BF85C1B01C0E7DE49A06D8B07C2FD135C32B828B387FA09001AFC5DAFF92F5BB2B8';
wwv_flow_imp.g_varchar2_table(40) := '7994BEBD75C45FE4C0DF595C3B087CEAD7B619EDB3737EB7F7E7C78F19D5D26D1ED31040A05E8170FFF5ADD78DBD3B0AD806C1C50BE63B6EC9BFC5160D1477943DBDBAC9E6659333470F4C9F34EBEB8D2B879AD7EA6F6B5DD79F75A18267DCB074A1F9EC';
wwv_flow_imp.g_varchar2_table(41) := '7DB73A8500DD0BA15A5453C1CD6073080420E0771309007EF74FF0AD9BB45C02185C30106C8DB6B6DB6A9FAD700D981A38679BDF9E7EE39A15AD81F89A024FF7B7B76D7BD6D980DFF91BB7B7EE0DB02DAB5A4E8FEEB72DC67C0410A85880005031786ABB';
wwv_flow_imp.g_varchar2_table(42) := 'D33FFE5935EB33F559F37D9EB7A851FCFFFBE853132E37FD69F0D7DDFAB5FACC99D3BAECF0E3CBABE60000100049444154A16D9BADCDD0DF019702AC4C2C109980EFE514FF2F98EF15D33EAF044E9E9FF4AA3D791A736A32FBFF7D34E8E5D99E963D3F7E';
wwv_flow_imp.g_varchar2_table(43) := '5C4F998F6B970EB53EAA97B95085333FF8AE95466DB2ED5267366CCBD4317FB279C945372BEA71E6E841737A74C4E8078F4EBDFA62EB59AF354DF3F4D07284993A7A8A7D162D90FD2F58D17B637BC909CC69584EF19F3F17AE89A5EDD6DA3B2A7739FAD7';
wwv_flow_imp.g_varchar2_table(44) := 'CD77FFF4FEF776AC59F3DBE699009D8D50DBB25AA240A41AB396A9625E7BC0D7A0AE415EDFAE38F58985C3461F5FD41918B5556DD1B31E9AA6797A6859DDA0A960A040A09A0804D2E23153C0FF770400FFFB28E8165ED59897D9FEF189B399F37D9E696B';
wwv_flow_imp.g_varchar2_table(45) := 'BBADF6CEDA5C7E31F1E33B6F36A639E076AE5BF77BDD13F089BBDF636CDF15E0526359B5E8C85D83767BC0D7A0DECFBE140C1408CE1C3D60DA8140FBE8679BAC8B40950204802AB5D9D71502A7CE9EBF625A28134E4E9CCE6C6A9E00D03A8A6C9E8ACEDA';
wwv_flow_imp.g_varchar2_table(46) := 'E07D5B6FACF46EFFACB6749B77C3D285E6F69BD6779B7569DAD4A03976E97D152F7474AE815F47EEDA7F59FBD4B6B58FA97DF19B08653987B2DD10DA490008A197026EA36D10BC706622D8EA4E9EBD5058DB5D8E8CEFBB794D61FB2B6B43B70FAFF2E62C';
wwv_flow_imp.g_varchar2_table(47) := '407BE0D7D1B906E7B26AEEDCAEF6D50E020A769DF3798F802F0204005F7A22D276D802C0C8E8B1602B3F7CE46866DB6DB54F5F5983C6F4F79DAF75F4EFE3A9FFCE76EA5280CB59000DCE9DEB16F55ED7F8757DBFEA81BFB3FDEAD3D6E581037BF9A9E44E';
wwv_flow_imp.g_varchar2_table(48) := '9CE8DF87512001208C7E0AB6957317647F5BDE91B7C74D889F04509B47DFCABE63DF567BBB535D8E124338FA6FD7E37216A088DF4968EF6FFAB3067F5DE3EFF7FAFEF46DF6FB5A41E0F4E87E4240BF90AC5FB80001A0705236385DC07614AC7F1C8F8C8D';
wwv_flow_imp.g_varchar2_table(49) := '4F5F2588D7277E75C2DACE390B165B97D102B6A3E1508EFE558B1E3A0B70D3F5EBF472D6C78589E2FBFCC2C449A3C17FD69DD638437FE70A0167C7B837A0C66EA86CD7A1EC8800104A4F05DACEAB1A0366AE65203C7C34FB48DAC7D28F1CCF0E008DC1A5';
wwv_flow_imp.g_varchar2_table(50) := 'CECDD69DE4590B0FAFE8F117FDB2365AF2BCE19543997B98B47C4364E6CA5D666A60D529FF2EB39C267DFCB61BCCBFFEC44EF3954FDE65FEEC731F30BB7FFBC3E6E5873FD27AE8B5A6FDE7CFBEDF7CF1AF6F373B37AD356BAF59E8B4DDE90B2904E8DE00';
wwv_flow_imp.g_varchar2_table(51) := 'B575FA745E2350970001A02EF984F63BD73218EE7FE34D73F24C381F07D4E9FF3DFB5FCFEC41D7A37F97D3FFFA59DECC9D7938F3D6D58B336F06D460A823F6229A7E7A74C46860CDBBAD4FEEBCC57CE5D7EF690DF28F7C648BF9D8BBAF351FBD7999D97E';
wwv_flow_imp.g_varchar2_table(52) := 'DD62B36649E3D2E6F45AD376AC19345FD8B1DA3CFA1BDBCC77BF789F5120F8C41D9B738701B5F5CCD18397B6CF8BD804C2A98700104E5F05DB52DB19000D06FB0E1C09A6BE7DAF1DB2B6D556737B0393968FFE2D5FB1B2BD6858CF73E6986B87AEC96C73';
wwv_flow_imp.g_varchar2_table(53) := '11F701E8683AEFF57E0DFCBBFFC987CDBFDA356C3EFAAEEC331559052810FCDE033799FFF4F7EF35DA669EB3023AEBA3B6676D9F7908942D4000285B98ED1B97CB002FFE723488B3004E47FFCDCB1EAAD9A5EB272DA7C2B75DBFDC65335E2EB361E5B2CC';
wwv_flow_imp.g_varchar2_table(54) := '76D96ACF5CB9395367107434DD7CE9F43F0DD2ED817FCDE0E5237CA7953316D219028589BC41406D270464C0063A2BA466130042EAAD80DB6ABB0C10CA590097A3FFC6D0AAC27A6A6841710355618D72DCD0B2AB17672ED94F00D0E0EF7ACD7FFDB54B5A';
wwv_flow_imp.g_varchar2_table(55) := 'D7F535481739F07716D70E025FF9D45D46FBEC9CDFEDFDF9F16346B5749BC73404CA162000942DCCF65B023A25AE47EBCD2CFFD15980F177DE99656EFD930FFFEA94B15EFB6F1EFD3706DD4F2BDB06C1A14503F517DE630BAE997F558F6B66AF36D9BC6C';
wwv_flow_imp.g_varchar2_table(56) := '72E6E881EC852ECEBD73E32AF3D86FDDDDBAAE7F7152E94FDB572F348F7DFA6EA710A0E0AB5A269B3595DE307650814058BB200084D55FC1B656A7C40786B2AF67EB1FC3EF3DFF575E5E0AD04D8ADFFDE91EABFFBCE5D91F7FEBDCC0A4E512C0D0A2F99D';
wwv_flow_imp.g_varchar2_table(57) := 'AB04F3DED6765BEDB315AA01537F2BB3CD6F4FD7DDFA8FFD9D1DA6CCA3FEF6BE3A9F7536E03B5FB8B7756F40E7BCCEF7AAE5F4E8FECEC9BC47A074010240E9C4ECA02DA03BE36D67014E9C7AC7ECFED9CBDE7D39D0D32FD9FF81566DAAB15DAFCBB3FEF1';
wwv_flow_imp.g_varchar2_table(58) := 'CF5A4E9FA9CF9AEFF3BCA1F9730B6F9E3E35E172D39F067FDDAD5F7803726E50971DBEF8C036EB5AFA3BE0528095C9FB05426B200120B41E0BBCBDB6B3002A4F21C0E55ABB96ADE2B1FBF9BDC6F6AD7F6A874B6D5A2ECFE3ED89707F2CE9ED339399A56A';
wwv_flow_imp.g_varchar2_table(59) := 'D0CB5CA0CBCCF3E3F6EF8CB87EE5B5AD8FEA7559BD96495FB863AD519B6C3BD7990DDB32CC47A048010240919A6CCB2AA023641D29DB16D4B5F63DAF1DAEFD4C80EBE0AF9A549BADAECEF9731AD9D7F827278BFBC1A1CE7D97FDDED6765BED9DED7339FA';
wwv_flow_imp.g_varchar2_table(60) := 'D7CD77FFEB1FECEC5CB5F6F78FFEED1DD67B0214885463ED8DA5013D0A84B71A0120BC3E0BBEC5BA4EEEF28FFF9E5746CC53CFBF54CB3D01BAE6EF3AF8AB96F9AB877BEA17DB57258F9D3ADDD3767D58C9D6765BED9D35B8FC62E2971FDCDEB99A17EF75';
wwv_flow_imp.g_varchar2_table(61) := '4FC0971F7A9FF54B835C6AF4A2201A11850001208A6E0CAB08DD10387FF546A7461F1E1B6FDD1350E5A70374B7FFE33F7ACEE9B4BF8A50A0D173198FB74F679F462F639F456D73EC54F6B73BE609003A32D6117256DBFEF1AEF7567AB77F565BBACDD3A7';
wwv_flow_imp.g_varchar2_table(62) := '031E7ADF4DDD665D9AA61A55EBA509BC084620C486120042ECB508DAAC10E03A70EA9E806FFDE465F3937D6F947A3660F2C2F9D63E5CEEF66F77C182E6917F2FA7FEDBEBDB06C10B67033E033071AE5D66DFCF2E47C6FF70E7F57DEFA7EC0D3CF89E359C';
wwv_flow_imp.g_varchar2_table(63) := '05281B99ED3B0B10009CA958B068017D5E7EC0F14B737464F4CAC86BE689A7F6B406699DA22FAA3DED81FFBF3CF9ACD13E5CB7ABB6F733F86B3FB600F0C26BE17C45B2EA99FE187923FB97EF6CB54FDF96FA7FFAFBCED73AFAEF9CE6E37B5D0A70390BC0';
wwv_flow_imp.g_varchar2_table(64) := '27027CECBDAC3685398F001066BF45D3EA3C2140456B20D020AD20B067FF41337AFC573DDD28A8417FE4AD13AD309177E0573B74D3DFC0D00ABDECEB3177C1A2CCF5478E8C99103F09A036EF3B941D006CB5B7615C4E898770F4DFAEC7E52C4011BF93D0';
wwv_flow_imp.g_varchar2_table(65) := 'DE1FCF08CC264000984D86E99508E85240DE10A0862908E89302BB9F7BD93CF1173F37BA614F9F1A5020D0357C9D21D0F7F66BA0D76B4DDB7FE4B8D9D73C2AD5B21AF47FFCFC4BB98EF8B55F3D74E4DFEB4D7F5A7FFAC37614AC3A5F3D766AFA2A41BC3E';
wwv_flow_imp.g_varchar2_table(66) := '7662DCDA4ED7B327B6A3E1508EFEDB203A0B70D7BBB36F1ABD3061F76B6F8FE7FA05426D010120D49E8BA8DD0A013A9A76BD27A0B3740D92FA9CBE3E35A040A06BF8BA89EFF1EFFFC468A0D76B4D7B6ACF5EF3F44BFB9C6FEEEBDC8FDEEB9ABFDAAAD745';
wwv_flow_imp.g_varchar2_table(67) := '3C54FBDC05D9DF99BFBF195A8AD85795DB1879F344E6EE1A834B33E74F9FA95FCE9BFEBEF3F51DD767FFE850E7F23EBCDF717D76FDBD7E4BA20FB5D18670040800E1F455F42D6D0C0E9985EB361B7DACCEB762D5260DFEAE47AD79DA6FFBA1A4E74746CD';
wwv_flow_imp.g_varchar2_table(68) := 'D83BD977D4E7D95FD9CBEAF4FF937BF665EEC6D5D1E5F4BF7E963773671ECED4CF1067FD7CB042ED8589931EB69C265D2910EE140240B87D1765CB7544AC8F0836721C21960DA123F4050A269623F55EDBA1ED67ADABC1E0E72387B316F16ADE73FBDFB0';
wwv_flow_imp.g_varchar2_table(69) := 'B6C756737B0393961FC9B961CDEAF6A2C13DAF5F997DE682FB0082EBD2E01A4C0008AECBE26FB042C0BCE56B8D2E09B80E1465A8E8A85F6D28EA7AFF6C6D54BDB63A7FF0F22F83380BE074F4DF1830AA79368FE9D3272D3F96F4D1AD6BA72F1ED4EBF70D';
wwv_flow_imp.g_varchar2_table(70) := '67DF446AAB3DA862236E6CC8A5110042EEBDC8DBDE685E12D0E0AB4158837155E56A5FDAA78EFAD5862AF66BBB0C10CA590097A3FF86E3473F5DDCD70ECE7359CCCB65D60E65DFFB4100F0B2DBA26A140120AAEE8CB3180DC2BA2CA041D976A4DC8F8006';
wwv_flow_imp.g_varchar2_table(71) := '7EDDE15FE5C0DF6EAFEAD2A3FDBEDB73EB2CC0C9896EB3BC98F6EA5BE3C67AEDBF79F4AFFE746DB06D105C7B4DB83F97BC76C9802B03CB792B1076C3080061F75F32ADD729630D1C3A23A01B0515061A7DDE27A0015F83AE06FD451BB6180DFC03057CB6';
wwv_flow_imp.g_varchar2_table(72) := 'BF974E517D03432B3357D55980477FF0A29797027493E29F7CF7B9CCF66BA6FA4DCFAE0F5B00B86E30DC00606BBBAD765743964360360102C06C324CF756408365A3797940F7092C5CB7D9E8EE7C0D2C8D6620D04383BA067715A0673D344DF3069AA79F';
wwv_flow_imp.g_varchar2_table(73) := 'F5D03A1AF01528EA1AF4D5BEE90FDD19AF764E9FD6F9FAD88993E6D127FFD2BB2F077AFCD9573A9B7AC57BD5A61AAF98913141A12763B6D167EAB3E6FB3C2FE4B6FBEC5A65DB42DF170120F41E4CBCFD0A031A541A170381428106750DEEEDA37ABDD634';
wwv_flow_imp.g_varchar2_table(74) := 'CDD360AF87D6F1916EC07216406D560870B9D6AE65AB783CF6A3978DED5BFFD40E97DAB45C9EC7A1F1E27E6F20CF7E8B58D6D6765BF829A20D6C236D010240DAFD4FF59E092898E848D9D62C5D6BFFFE2F466B3F13E03AF8AB26D566ABAB73BECEDE744E';
wwv_flow_imp.g_varchar2_table(75) := '9BF13EDC1F4B34C6D2766BED33207853BD40F87B240084DF87541099802E67B8FCE3FFBD17F69A6F3C55CF3D01BAE6EF3AF8AB169D81E9A59B6C5F95FCC678B8BF96686BBBADF65E3C590781E9020480E91ABC46C003015DD6D0A71E5C9AB2FFC858EB9E';
wwv_flow_imp.g_varchar2_table(76) := '80B10A3F1DA0BBFD7FFF89A79C4EFBAB06051A3D97F13878229C6F48ECACFFE0DBD9E18500D029E6D7FB185A430088A117A9213A018500D78153F704FCC1FFFCB9F9E60BAF97FB09810B175AFB70B9DBBFDD21BAD9B29753FFEDF56D83E0E4F9F3ED4583';
wwv_flow_imp.g_varchar2_table(77) := '7B3E387E26B836D3E0B804080071F527D54424A01B1B0786563955A41BC67EF68BFDE60FBEFD6C6B90D6297AA7155D16BA38F03FFCE77F61B40F9755B48CDADECFE0AF6DD802C0137B5ED762413E9EDD379AD96E5BED992B33B3648138364F0088A31FA9';
wwv_flow_imp.g_varchar2_table(78) := '2252813C214004D383C0932F1F30236FBEDDDB8D82CD41FF2F0F9D688589BC03BFDAA19BFEF4690BBDEEE73177C1A2CCD57F3A72C41C0AF093006AF333AF1CCCACCD567BE6CACC44C0418000E080C42208D425A04B01794380DAAA20A04F0AFCE9F75E30';
wwv_flow_imp.g_varchar2_table(79) := 'FFF6BFFFC4E8863D7D6A408140D7F0758640DFDB6F9A03BD5E6BDA0BAF1F37CFBF76B4B5AC06FDFFF6A39FE73AE2D77EF5D0917FAF37FD69FDE90FDB51B0EAFCD9A1F1E9AB04F1FAD0AFECDFE8D8EFD9932020026D642CCD2600C4D2939ED7716E7CCC9C';
wwv_flow_imp.g_varchar2_table(80) := '397AB0F5383D3A62260EEC35A75E7D318A876A514D7A9C1D7BD35C983869262DBF6297A7BB14027434ED7A4F40E7B63548EE3BF4A6D1A7061408740D5F37F1FD9B6FFE1FA3815EAF35EDEB3FDE63BEF1F44BCE37F775EE47EF75CD5F6DD5EB221EAA7DAE';
wwv_flow_imp.g_varchar2_table(81) := 'E557189F7DF56811BBAA741B3FFDE5B1CCFD35069766CE672602450810008A50641B5D05DA83BE06FA33470F9873E3C75B8FF3CD01528352D795029CA85A54931E67C70E9B8966C079A7197014088A0C038DC121A36F3ED4C7EA7C63529B34F89771D46A';
wwv_flow_imp.g_varchar2_table(82) := 'FBA1A4C77FBEDF1C3A11CE1702E9F4FF1FEEFEBF995D588663E60E999943209E450900F1F4A5379568E0D751717BD0F7A661153744814061E0F4E8FE66F0192BE4AC808E88F511C1864747883A42D7B72D96356869FB595DA700F6CD970E652DE2D5BC6F';
wwv_flow_imp.g_varchar2_table(83) := 'BE686FABAD66AF0AA231C10A100082ED3AFF1A3E7DE0D73FCAFEB5B09E16C94261A81D04FA6D854280BED65897EF35C104000010004944415404EA1C2874D4AF361475BD7F3617D56BABF38F7FF08B20CE02381DFD37068C6A9ECD83E9F50AC4B4770240';
wwv_flow_imp.g_varchar2_table(84) := '4CBD59532DBADE7DBA79DA5B839C06BB9A9AE1FD6E65232359C9ACDF06379A970434F86A10D660DCEFF65CD7D7BEB44F1DF5AB0DAEEBF5B39CED32806C43380BE072F4DF70FCE8673F9EAC8B8004080052E0D1B380AE719F6E9EE2D6E9EE9E3792D88AB2';
wwv_flow_imp.g_varchar2_table(85) := '9259112140741A8475594083B2ED4859CBF7FAD0C0AF3BFCAB1CF8DB6D555D7AB4DF777B9E3A0BE0EF37033EF7C64963BDF6DF3CFA577F76AB8F693E08C4D50602405CFD5969351AFC758D5B475F95EE38829DC94C370AEAB24911E5E894B1060E9D11D0';
wwv_flow_imp.g_varchar2_table(86) := '8D820A038D3EEF13D080AF4157837EFB971507865614D1DCDCDB507D03965F4A94E967BEFAB49797027493E26FFDE90FAC75ABDFAC0BB10002050910000A824C6D33EDC13FB5BA8BAE5797046459E4763558369A9707749F80C280EECED7C0D26806023D';
wwv_flow_imp.g_varchar2_table(87) := '34A86B70D73EF5AC87A669DE40F3F4B31E5A4747FA0A14750DFA6ADFF4876E32543BA74FEB7CFDFA5B27CC67BEFA94775F0EF4F0FF78B1B3A957BC576DAAF18A194CF04620B686100062EBD10AEAD1A96B1DF9E7DDD54DEBD798BBB76E36F7DFB1D53C74';
wwv_flow_imp.g_varchar2_table(88) := 'EF76F3E95D3B837FA80ED5A3BAB66E1A36ABAF5D6A962C5A988B469632CDB592E3C20A031A541A170381428106750DEEEDA37ABDD634CDD360AF87D671DC45A58B0D58CE02A8310A012ED7DAB56C158FCFFED7178CED5BFFD40E97DAB41C0F048A122000';
wwv_flow_imp.g_varchar2_table(89) := '142599C8763450E9D4759E7235386AB0DFB9F97AB371E552B3EAEA4566F1BC813C9BF07659D5A17A54D7D61B56995DB76D363BB76C320A3B79824091F704788B5540C3144C74A46CDB94AEB5FFC79F1EACFD4C80EBE0AF9A549BAD2EE6D72910DFBE0900';
wwv_flow_imp.g_varchar2_table(90) := 'F1F569A915E994B5EB0E7444AC815F83A3EB3A312CA740A0B0B36BC72DCE4140D7AF8BBA1F2006C3AC1A743943972DB296D1BCFFF0BF5F30FFE25B2FD4724F80AEF9BB0EFEAA456760D4661E0854294000A8523BF07DE96B6E7507BBAD0C1DF9EAB4B88E';
wwv_flow_imp.g_varchar2_table(91) := '886DCBC63C5F6707140474464026B65ACF8E1D6E7D8DB06DB9D4E7EBB2C6FCD51B9D187EB2FFF0D43D0127AAFB7480EEF6DFF5EFBFE374DA5F4528D0E89987DF0231B68E001063AF9654930628DBA635D0E9C85747C1B66553992F0BD710A0332CBACC92';
wwv_flow_imp.g_varchar2_table(92) := '8A4DAF752A04B80E9CBA27E0813FFABEF997BB474A3F1BA07DB8DCEDDFAE5B375B72EABFADC173D5020480AAC503DD9F8EFE6D4DD7E0FFB1BB6F8DE6FABEADDE3CF31502148C6494B51E9702B27466CED38D8D0343AB664E9CE59D5CBFFECCCBE6813F7A';
wwv_flow_imp.g_varchar2_table(93) := 'B29420A081FF9647BE6DB48F599A70C564B59DC1FF0A164F27C4D92C02409CFD5A78552E47FF3ACA2D7CC7116DB0754960CB266B45E7C7B37F29CEBA818416C81302C4323D08FCF133BF343F3B34DEF38D82DFFAABB15698C83BF0AB1DBAE96FA0A6EF54';
wwv_flow_imp.g_varchar2_table(94) := 'D0FE7920200102801478640AB81CFDEB863F1DE5666E8899AD4F40E8130259141AA4B821304BE8F23C5D0AC81B02B4B68CF54981BFF7E80FCD037FF8A4D10D7BFAD4800281AEE1EB263E7D6FBF96D56B4DFBD62F8E9927FEDF5BAD6535E8FFEE9FFF38D7';
wwv_flow_imp.g_varchar2_table(95) := '11BFB6A5878EFCB9E94F12E13C626D290120D69E2DB0AE0B13E3995BD369EDD46FF8CB04EA98F9DEE1EBACDF15A07B014EBDFAA289E1A15F863C3D3A62F45098BC3071B2905F466CB32A04E868DAF59E80F67AED6785017D4E5F9F1A5020D0357CDDC4B7';
wwv_flow_imp.g_varchar2_table(96) := 'EBDF7DC768A0D76B4DFBDDAF3F6DFEF9379E71BEB9AFBDFDE9CFBAE6AFB64E9FC66B04EA122000D4251FD07E6D77FE0FAF5D1D5035F5375597025232D300ABBF213DCE8E1D36FAE2237D978402419161406702F4CD87FA585DFDBD3CB3056A93067FAEF9';
wwv_flow_imp.g_varchar2_table(97) := 'CF7409E35DBCAD2400C4DBB78554E672473A47FFF9A8F71F396E460E8EE65B29C2A5150814064E8FEE37BAE4E1F2B76663D0D9007D44B031B8D4B66865F375BD7FC1BACD86C1BF327276E428400070844A7531FDC39C55BB4EFF67CD67DE65010DFC5FDD';
wwv_flow_imp.g_varchar2_table(98) := 'FD8C796ACF5E73E2D43B976724FE4A670874C9A31D04FAE55008D0D71AEB928006DF7EB7D7EBFA3AEA571BB8DEDFABA01FEBC5DC0A0240CCBD5B406D93E7CE646E25A553D9991019334F9E396B763FBFB735F0672C96FCACCB4160A4907B041A83434683';
wwv_flow_imp.g_varchar2_table(99) := 'AF06610DC655016B5FDAA78EFAD586AAF6CB7E10C82B4000C82B96D8F2B600B06AE992C444F2957BF857A7CCE33F7ACE8CBE753CDF8A092FAD4B033A1B3079EE6C210A1A84755940837299670434F0EB0E7F06FE42BACD938DC4DD0C0240DCFDDB777593';
wwv_flow_imp.g_varchar2_table(100) := '963300830BE2F8519FBEA1BA6C4083FF777FBAA7CB1C26D904743640370ADA2E41D9B6D39EAFCB02534160D8E846418581469FF70968C057A0D0A0DFFE6545EEF06F8BF31C82000120845EAAB18DFA87386BF7BAA33D6B7EAAF318FC8BE979DD1BA04F0A';
wwv_flow_imp.g_varchar2_table(101) := '14B3B5A9ADB4C380EE135018D0DDF9ED40A050A0415D83BB96D6B31E9AA6791AECF5D03A3AD2D72506067D49C5F988BD2A0240EC3D4C7D950BF43AF86FDFB4DE7CF29EADE6F3F76F375FFAD8DDE691DF7C7FF00FD5A17A54D787B66D3637AE5961962D59';
wwv_flow_imp.g_varchar2_table(102) := '9CAB4FF44981C9822E0774EE58614077E73706878C02811E1AD435B82FDAB0C5E8590F4DD33C0DF67A689DCE6DF11E81D0040800A1F518EDF55A4037FCE53DEDAFC15183FD43DB379A6DEB979A0DD70E9AA185715C5A511DAA47757DF0E6D5E633F7DE62';
wwv_flow_imp.g_varchar2_table(103) := '3EBEF366A3B093270814794F80D77F4034CE2381F89B420088BF8FA9B04281A75FDAEFBC371D116BE0D7E0E8BC52040B2A1028EC7CF6BE5B9D83802E4515753F400484948040210204804218D90802C6EC79EDB0D3DDFE3AF2D569711D11A7ECA6B3030A';
wwv_flow_imp.g_varchar2_table(104) := '023A2320139B85BE45B0E8FB016CFB647EBA0229544E0048A197A9B174019DFADFF3CA88753F1AE874E4ABA360EBC2892C200BD710A09B02CBBA1F20116ECA44E0920001E012052F10E85D60DF1BF69FF0D5E0FF3B1FD911CDF5FDDEB5AE5C532140C148';
wwv_flow_imp.g_varchar2_table(105) := '4657CEBD3C854B01972D7855A6401ADB2600A4D1CF5459B280CBD1BF8E724B6E46D09BD7250117A3F3E3F6B01534048D47A02201024045D0EC265E015DFBB755A71BFE74946B5B2EF5F932D22704B21C380B90A5C3BC220452D9060120959EA6CED2048E';
wwv_flow_imp.g_varchar2_table(106) := '1C1BCBDCB64E6BA77EC35F2650C7CC0FDEB2DEFA5D01BA17E0D4AB2F9A181E1307F69AD3A323ADC7D9B1378D6E74E43E878E3F0ADE962240002885958DA622A09BFF6CDFF37FDB8DEB52E128A44E5D0A48C94C6734F4FB077AE8930EFAE2237D0DB24281';
wwv_flow_imp.g_varchar2_table(107) := '3EFA481828E4CF2AC746D2599400904E5F53690902E313F61FACE1E83F1FFC0BAF1F37CFEF3B906FA508975620D0998ED3A3FB0D4120C20EF6A0240280079D4013C215387CFC4466E375FA3F7301665E12D0C0FFF0D77E68BEFEE33DE6D8899397A6A7FE';
wwv_flow_imp.g_varchar2_table(108) := '4267080802D5FD15A4B42702404ABD4DAD850BD8AEFFA7742ABB57DCB177CE9AC77EF4726BE0EF751B29ACD70E020A035C1648A1C7CBAF910050BE317B48586078C560C2D5DB4B7FF5AD71F3FB4F3C65F61D7AD3BE304BB404746940970508012D8E82FF';
wwv_flow_imp.g_varchar2_table(109) := '93D6E6080069F537D5162C70F29D89CC2D0E2D9A9F393FE5991AFCFFE4BBCFA54CD073ED3A1BA01B05756F40CF1B61C5E4050800C9FF0900D08FC08953EF64AEAE3BDA3317487426837F311DAFCB01FAE860315B632BA909100052EB71EA45A066815E07';
wwv_flow_imp.g_varchar2_table(110) := 'FF4FDCB1D97CE59377993FFBDC07CCEEDFFEB079F9E18F44F1502DAAE98B0F6C333B37AD35EBAF5D92AB87F4D1412E07E42263E18B0204808B103C218040F902BAE12FEF697F0DFA1AEC7FEF819BCC476F5E66B65FB7D8AC59D228BFB115ED41B5A8A62F';
wwv_flow_imp.g_varchar2_table(111) := 'DCB1D63CFA1BDBCC77BE706F2BE8E40902DC13504467A5B70D02407A7D4EC508D426F0F8B3AF38EF5B47C41AF835E83BAF14C982AA594140673D5C8280EE09383B76C4702620923F808ACA20005404CD6E10485DE0FBBF1875BADB5F039E4E89EB883875';
wwv_flow_imp.g_varchar2_table(112) := '339DF5F8F283DB9D2E0B9C1B3FDEFAC2A0D4CD7AAD3FC5F5080029F63A352350B1804EFD7FEF85BDD6BD6AF07FECD377B74EF35B174E64015D1E90896C6C25EB971227CFD9BF9DD2B61DE6A721400048A39FA912815A059E7FED2DEBFE35C0E9B4B7AE89';
wwv_flow_imp.g_varchar2_table(113) := '5B174E6C01993CD60C4632CA2A5D9702F8686096D06CF3D29C4E0048B3DFA91A814A055C8EFE75AABBD24605B63385807FF4C12DD6CB019C0508AC636B6C2E01A0467C768D400A02BAF66FAB5337FCE954B76DB9D4E7EBE6C007B7DF98C9A0B300FAB6C0';
wwv_flow_imp.g_varchar2_table(114) := 'CC8598394320D5370480547B9EBA11A848E0D523C732F7A4D3DADCF097493463A6AC64366362C79B0B13FC985207096FBB081000BAA0300901048A11D0CD7FB6EFF9B71DD116D392B8B66233D3270226B919D0B1D3D35D8C00906EDF533902A50B8C9D3A';
wwv_flow_imp.g_varchar2_table(115) := '6DDD878E68AD0BB1C00C0199D9CE024C9E3B33631DDE20D0294000E814E13D0208142630F2E678E6B66C8358E6CA89CF5CBBECEA4C81F313A732E733734A20E5FF120052EE7D6A47A06401DBF57FDBA9EC929B17F4E6DF37BC22B3FD9C01C8E461665380';
wwv_flow_imp.g_varchar2_table(116) := '00D044E07F0820508FC01DEB87EAD971047BB5D911005C3A39ED65080069F73FD52350AAC0F113D9A7A1AF1B9C5FEAFE63DEB8CD8E001073EF17531B01A01847B68200025D048E9DC8FE389ABEDCA6CB6A4C7210B0D9E9FB001C3693F422A9174F0048FD';
wwv_flow_imp.g_varchar2_table(117) := '2F80FA11400001049214200024D9ED148D000208A42E40FD0400FE06104000010410485080009060A7533202082090BA00F51B4300E0AF000104104000810405080009763A2523800002690B50BD04080052E08100020820804062020480C43A9C721140';
wwv_flow_imp.g_varchar2_table(118) := '0081D405A87F4A800030E5C07F114000010410484A8000905477532C02082090BA00F5B70508006D099E11400001041048488000905067532A02082090BA00F55F1620005CB6E015020820800002C908100092E96A0A450001045217A0FEE9020480E91A';
wwv_flow_imp.g_varchar2_table(119) := 'BC4600010410402011010240221D4D9908208040EA02D43F53800030D383771D02731A031D5366BEFDEAEE674C3F8F995BE31D020820804055020480AAA403DDCF558D7981B69C6623800002D30578DD294000E814E1FD0C0102C00C0EDE20800002D108';
wwv_flow_imp.g_varchar2_table(120) := '1000A2E9CA720A19185A696C9701CAD9335B450001048A13604B570A1000AE3461CA3481AB1A0366EEE0B269537889000208201083000120865E2CB98681A11566EE82C525EF85CD238000026509B0DD6E0204806E2A4CBB4260FEEA613330B48ACB0157';
wwv_flow_imp.g_varchar2_table(121) := 'C83001010410085380001066BFD5D26A9D0998BF7A632B08E88C00F706D4D20DEC140104720AB078770102407717A6CE22A07B02A682C0B059B06EB359B4614BE66396CD301901041040A066010240CD1DC0EE1140000104CA1460DBB30910006693613A';
wwv_flow_imp.g_varchar2_table(122) := '020820800002110B100022EE5C4A430001045217A0FED9050800B3DB300701041040008168050800D1762D8521800002A90B507F960001204B8779082080000208442A400088B463290B010410485D80FAB3050800D93ECC45A02F8187BFF643D3CFA3AF';
wwv_flow_imp.g_varchar2_table(123) := '9DB33202082090214000C8C061160208208040A802B4DB264000B009311F0104104000810805080011762A2521800002A90B50BF5D800060376209041040000104A213200044D7A51484000208A42E40FD2E020400172596410001041040203201024064';
wwv_flow_imp.g_varchar2_table(124) := '1D4A3908208040EA02D4EF26400070736229047A1258B4618BC97AF4B45156420001040A1020001480C82610400001047C11A01DAE0C3A9E7D00000EE5494441540204005729964300010410402022010240449D492908208040EA02D4EF2E400070B762';
wwv_flow_imp.g_varchar2_table(125) := '49041040000104A211200044D3951482000208A42E40FD7904080079B45816010410400081480408009174246520800002A90B507F3E0102403E2F9646008102056E79E4DBA69F47814DA96553FDD4AE75B31A3DA73190359B79081802007F0408208040';
wwv_flow_imp.g_varchar2_table(126) := '84025735E64558555649CCCB2B4000C82BC6F208208040000273160C06D04A9A58A70001A04E7DF68D0002089424D0181C2A69CB7E6E9656E5172000E437630D041040C06B8181A155E62AEE01F0BA8F7C681C01C0875EA00D08208040410273172C3603';
wwv_flow_imp.g_varchar2_table(127) := '432B0ADA5A289BA19DBD0810007A51631D041040C0438179CBD799F9AB873D6C194DF2518000E063AFD026041040C051A031B8B479C4BFCA2C5CB7D93412BDEEEF48C5621D0204800E10DE22804075028B366C31598FEA5AE2E79EB26CDAF3E62D5FDB0C';
wwv_flow_imp.g_varchar2_table(128) := '002BB8E6EF67177ADD2A0280D7DD43E31040000104B20598DBAB0001A05739D64300010410402060010240C09D47D311400081D405A8BF77010240EF76AC89000208208040B002048060BB8E8623800002A90B507F3F0204807EF4581701041040008140';
wwv_flow_imp.g_varchar2_table(129) := '05080081761CCD460001045217A0FEFE040800FDF9B136020820800002410A100082EC361A8D000208A42E40FDFD0A1000FA15647D0410400001040214200004D8693419010410485D80FAFB172000F46FC816104000010410084E8000105C97D1600410';
wwv_flow_imp.g_varchar2_table(130) := '40207501EA2F428000508422DB4000010410402030010240601D467311400081D405A8BF18010240318E6C05010410400081A00408004175178D450001045217A0FEA20408004549B21D0410400001040212200004D4593415010410485D80FA8B132000';
wwv_flow_imp.g_varchar2_table(131) := '1467C99610400001041008468000104C57D150041040207501EA2F52800050A426DB4200010410402010010240201D453311400081D405A8BF58010240B19E6C0D010410400081200408004174138D440001045217A0FEA2050800458BB23D0410400001';
wwv_flow_imp.g_varchar2_table(132) := '040210200004D0493411010410485D80FA8B172000146FCA16114000010410F05E8000E07D17D140041040207501EA2F43800050862ADB440001041040C073010280E71D44F310400081D405A8BF1C01024039AE6CF5A2C09CC6C0C557DD9FBEBAFB1913';
wwv_flow_imp.g_varchar2_table(133) := 'F2A37B5553536DB54F2DC57F114000817A040800F5B827B3D7AB1AF392A9B5B3D0946BEFB4E03D02BD0BB06659020480B264D96E4B20E54170CE82C19601FF410001047C142000F8D82B11B5696068A549F55478637028A29EA41404EA1160AFE5091000';
wwv_flow_imp.g_varchar2_table(134) := 'CAB365CB4D81AB1A0366EEE0B2E6ABB4FE3730B4CAA8F6B4AAA65A04100849800010526F05DAD681A11566EE82C581B63E7FB355AB6ACEBF266B2080C04C01DE952940002853976D5F1298BF7AD8E8A838F6CB01F396AF33AAF552E1BC400001043C1520';
wwv_flow_imp.g_varchar2_table(135) := '0078DA3131364B47C5F3576F6C05011D25C712061A834B5B352D5CB7D934B8EE1FE39F2E35D524C06ECB15200094EBCBD63B04745D7C2A080C9B05CD0173D1862D26F4C7BCE56B9B016005D7FC3BFA9AB70820E0B70001C0EFFEA17508208040A202945D';
wwv_flow_imp.g_varchar2_table(136) := 'B60001A06C61B68F000208208080870204000F3B852621800002A90B507FF9020480F28DD903020820800002DE091000BCEB121A84000208A42E40FD55081000AA50661F08208000020878264000F0AC43680E02082090BA00F557234000A8C699BD20D0';
wwv_flow_imp.g_varchar2_table(137) := '55C0F665480F7FED8726E447D7A22F4EB4D57E71319E1040A02401024049B06C16011781947F2E39E5DA5DFE36D25D86CAAB1220005425CD7E10E82290F2203867C16017112621804055020480AAA4D90F025D040686569A544F85F3BB095DFE20986420';
wwv_flow_imp.g_varchar2_table(138) := 'A84E8000509D357B42E00A01FD36C2DCC165574C8F7DC2C0D02A7E3B21F64EA63EEF050800DE77110D8C5D403F8EA45F478CBDCE767DAA5535B7DFF38CC065015E55294000A8529B7D21308BC0FCD5C34647C5B15F0E98B77C9D51ADB330301901042A14';
wwv_flow_imp.g_varchar2_table(139) := '20005488CDAE10C812D051F1FCD51B5B414047C9B18481C6E0D2564D0BD76D368DC1A12C02E6252E40F9D50A1000AAF5666F08640AE89E80A920306C163407CC451BB698D01FF396AF6D0680155CF3CFEC79662250BD0001A07A73F68800020820708500';
wwv_flow_imp.g_varchar2_table(140) := '13AA162000542DCEFE104000010410F0408000E04127D004041040207501EAAF5E800050BD397B440001041040A076010240ED5D400310400081D405A8BF0E0102401DEAEC130104104000819A050800357700BB470001045217A0FE7A040800F5B8B357';
wwv_flow_imp.g_varchar2_table(141) := '04107010B07D19D22D8F7CDB84FCC822B0D59EB52EF31070112000B828B10C0208D42290F2CF25A7537B2D7F5AECB42940006822F03F0410F05320E54170CE82413F3B85564523400088A62B290481F8040686569A544F85A7F2BB09F1FDD58653110120';
wwv_flow_imp.g_varchar2_table(142) := '9CBEA2A5082427A0DF46983BB82CB9BA078656F1DB09C9F57AF5051300AA37678F08209043403F8EA45F47CCB14AD08BAA56D51C7411CE8D67C13A05080075EAB36F0410701298BF7AD8E8A838F6CB01F396AF33AAD509858510E8538000D02720AB2380';
wwv_flow_imp.g_varchar2_table(143) := '4035023A2A9EBF7A632B08E828399630D0185CDAAA69E1BACDA63138540DA6277BA119F50A1000EAF567EF0820904340F7044C058161B3A039602EDAB0C584FE98B77C6D3300ACE09A7F8EBF03162D468000508C235B4100010410C825C0C2750B1000EA';
wwv_flow_imp.g_varchar2_table(144) := 'EE01F68F0002082080400D0204801AD0D92502082090BA00F5D72F4000A8BF0F6801020820800002950B10002A27678708208040EA02D4EF830001C0875EA00D082080000208542C4000A8189CDD21800002A90B50BF1F0204003FFA8156208000020820';
wwv_flow_imp.g_varchar2_table(145) := '50A90001A0526E7686000208A42E40FDBE0810007CE909DA81000208208040850204800AB1D91502082090BA00F5FB234000F0A72F6809020820800002950910002AA3664708208040EA02D4EF930001C0A7DEA02D08208000020854244000A8089ADD20';
wwv_flow_imp.g_varchar2_table(146) := '800002A90B50BF5F020400BFFA83D620800002082050890001A012667682000208A42E40FDBE0910007CEB11DA83000208208040050204800A90D90502082090BA00F5FB274000F0AF4F6811020820800002A50B10004A27660708208040EA02D4EFA300';
wwv_flow_imp.g_varchar2_table(147) := '01C0C75EA14D082080000208942C4000281998CD23800002A90B50BF9F0204003FFB855621800002082050AA0001A0545E368E000208A42E40FDBE0A10007CED19DA85000208208040890204801271D93402082090BA00F5FB2B4000F0B76F6819020820';
wwv_flow_imp.g_varchar2_table(148) := '800002A50910004AA365C308208040EA02D4EFB30001C0E7DEA16D08208000020894244000280996CD22800002A90B50BFDF020400BFFB87D6218000020820508A0001A01456368A000208A42E40FDBE0B10007CEF21DA87000208208040090204801250';
wwv_flow_imp.g_varchar2_table(149) := 'D92402082090BA00F5FB2F4000F0BF8F6821020820800002850B10000A27658308208040EA02D41F82000120845EA28D082080000208142C4000281894CD21800002A90B507F1802048030FA895622800002082050A80001A0504E3686000208A42E40FD';
wwv_flow_imp.g_varchar2_table(150) := 'A108100042E929DA89000208208040810204800231D91402082090BA00F58723400008A7AF6829020820800002850910000AA3644308208040EA02D41F92000120A4DEA2AD08208000020814244000280892CD20800002A90B507F58020480B0FA8BD622';
wwv_flow_imp.g_varchar2_table(151) := '800002082050880001A010463682000208A42E40FDA109100042EB31DA8B000208208040010204800210D90402082090BA00F58727400008AFCF68310208208000027D0B1000FA26640308208040EA02D41FA2000120C45EA3CD082080000208F4294000';
wwv_flow_imp.g_varchar2_table(152) := 'E81390D511400081D405A83F4C01024098FD46AB114000010410E84B8000D0171F2B23800002A90B507FA8020480507B8E76238000020820D0870001A00F3C56450001045217A0FE70050800E1F61D2D470001041040A067010240CF74AC88000208A42E';
wwv_flow_imp.g_varchar2_table(153) := '40FD210B100042EE3DDA8E0002082080408F0204801EE1580D010410485D80FAC316200084DD7FB41E0104104000819E0408003DB1B11202082090BA00F5872E400008BD07693F0208208000023D0810007A406315041040207501EA0F5F8000107E1F52';
wwv_flow_imp.g_varchar2_table(154) := '01020820800002B9050800B9C95801010410485D80FA63102000C4D08BD4800002082080404E0102404E3016470001045217A0FE3804080071F42355208000020820904B8000908B8B8511400081D405A83F160102402C3D491D082080000208E4102000';
wwv_flow_imp.g_varchar2_table(155) := 'E4C06251041040207501EA8F478000104F5F5209020820800002CE020400672A16440001045217A0FE9804080031F526B5208000020820E028400070846231041040207501EA8F4B800010577F520D0208208000024E020400272616420001045217A0FE';
wwv_flow_imp.g_varchar2_table(156) := 'D8040800B1F528F5208000020820E020400070406211041040207501EA8F4F8000105F9F52110208208000025601028095880510400081D405A83F460102408CBD4A4D0820800002085804080016206623800002A90B507F9C02048038FB95AA10400001';
wwv_flow_imp.g_varchar2_table(157) := '0410C814200064F23013010410485D80FA63152000C4DAB3D4850002082080408600012003875908208040EA02D41FAF000120DEBEA53204104000010466152000CC4AC30C041040207501EA8F5980001073EF521B020820800002B30810006681613202';
wwv_flow_imp.g_varchar2_table(158) := '082090BA00F5C72D400088BB7FA90E010410400081AE020480AE2C4C440001045217A0FED8050800B1F730F5218000020820D0458000D005854908208040EA02D41FBF000120FE3EA642041040000104AE1020005C41C204041040207501EA4F41800090';
wwv_flow_imp.g_varchar2_table(159) := '422F53230208208000021D0204800E10DE22800002A90B507F1A02048034FA992A1140000104109821400098C1C11B041040207501EA4F458000904A4F5327020820800002D3040800D3307889000208A42E40FDE9081000D2E96B2A450001041040E092';
wwv_flow_imp.g_varchar2_table(160) := '0001E012052F10400081D405A83F250102404ABD4DAD0820800002085C1420005C84E009010410485D80FAD3122000A4D5DF548B0002082080404B8000D062E03F08208040EA02D49F9A000120B51EA75E0410400001049A0204802602FF430001045217';
wwv_flow_imp.g_varchar2_table(161) := 'A0FEF4040800E9F53915238000020820600800FC1120800002C90B0090A2000120C55EA7660410400081E4050800C9FF0900800002A90B507F9A02048034FB9DAA11400001041217200024FE0740F9082090BA00F5A72A400048B5E7A91B010410402069';
wwv_flow_imp.g_varchar2_table(162) := '010240D2DD4FF1082090BA00F5A72B400048B7EFA91C010410402061010240C29D4FE9082090BA00F5A72C400048B9F7A91D010410402059010240B25D4FE1082090BA00F5A72DF0FF010000FFFF6A1DBF3200000006494441540300E8EEAA4BB3333368';
wwv_flow_imp.g_varchar2_table(163) := '0000000049454E44AE426082';
wwv_flow_imp_shared.create_app_static_file(
 p_id=>wwv_flow_imp.id(3415218567134210833)
,p_file_name=>'icons/app-icon-512.png'
,p_mime_type=>'image/png'
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/security/authorizations/administration_rights
begin
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(3415221434058210839)
,p_name=>'Administration Rights'
,p_static_id=>'administration-rights'
,p_scheme_type=>'NATIVE_IS_IN_GROUP'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'name', 'Administrator',
  'type', 'A')).to_clob
,p_error_message=>'Insufficient privileges, user is not an Administrator'
,p_version_scn=>'SH256:3yhrn6vMomFS9lJSiUELavVJBvfPg1Nm_2g2zEGMqLs'
,p_caching=>'BY_USER_BY_PAGE_VIEW'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/security/authorizations/contribution_rights
begin
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(3415221674985210839)
,p_name=>'Contribution Rights'
,p_static_id=>'contribution-rights'
,p_scheme_type=>'NATIVE_IS_IN_GROUP'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'name', 'Administrator,Contributor',
  'type', 'A')).to_clob
,p_error_message=>'Insufficient privileges, user is not a Contributor'
,p_version_scn=>'SH256:ciFz4rcxddalYIUr3Jinzh7tWbPXCTrEEDvj0GvJb6Y'
,p_caching=>'BY_USER_BY_PAGE_VIEW'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/security/authorizations/reader_rights
begin
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(3415221570870210839)
,p_name=>'Reader Rights'
,p_static_id=>'reader-rights'
,p_scheme_type=>'NATIVE_FUNCTION_BODY'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'plsql_function_body', wwv_flow_string.join(wwv_flow_t_varchar2(
    'if nvl(apex_app_setting.get_value(',
    '    p_name => ''ACCESS_CONTROL_SCOPE''),''x'') = ''ALL_USERS'' then',
    '    -- allow user not in the ACL to access the application',
    '    return true;',
    'else',
    '    -- require user to have at least one role',
    '    return apex_acl.has_user_any_roles (',
    '        p_application_id => :APP_ID, ',
    '        p_user_name      => :APP_USER);',
    'end if;')))).to_clob
,p_error_message=>'You are not authorized to view this application, either because you have not been granted access, or your account has been locked. Please contact the application administrator.'
,p_version_scn=>'SH256:rraFlo6EMInHtSUuxfoZXPob0ulO3Y_yKNkQ5x_t8NI'
,p_caching=>'BY_USER_BY_SESSION'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/security/app_access_control/administrator
begin
wwv_flow_imp_shared.create_acl_role(
 p_id=>wwv_flow_imp.id(3415221069607210838)
,p_static_id=>'ADMINISTRATOR'
,p_name=>'Administrator'
,p_description=>'Role assigned to application administrators.'
,p_version_scn=>'SH256:dheqzA6FvJpxO1XvRjEkdmp8Sopp4a5_9FwX9SJ6d2A'
);
end;
/
prompt --application/shared_components/security/app_access_control/contributor
begin
wwv_flow_imp_shared.create_acl_role(
 p_id=>wwv_flow_imp.id(3415221208341210839)
,p_static_id=>'CONTRIBUTOR'
,p_name=>'Contributor'
,p_description=>'Role assigned to application contributors.'
,p_version_scn=>'SH256:E1I9yvnWl7TTVCZZdLycGZM5J4upKtPrWG-og_uLylc'
);
end;
/
prompt --application/shared_components/security/app_access_control/reader
begin
wwv_flow_imp_shared.create_acl_role(
 p_id=>wwv_flow_imp.id(3415221391426210839)
,p_static_id=>'READER'
,p_name=>'Reader'
,p_description=>'Role assigned to application readers.'
,p_version_scn=>'SH256:vmP-ozbK0YK2PWJBw-FIve6SxhPxsqFi7yI6JPE-efc'
);
end;
/
prompt --application/shared_components/navigation/navigation_bar
begin
null;
end;
/
prompt --application/shared_components/logic/application_settings
begin
wwv_flow_imp_shared.create_app_setting(
 p_id=>wwv_flow_imp.id(3415222733562210842)
,p_name=>'ACCESS_CONTROL_SCOPE'
,p_value=>'ACL_ONLY'
,p_is_required=>'N'
,p_valid_values=>'ACL_ONLY, ALL_USERS'
,p_on_upgrade_keep_value=>true
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_comments=>'The default access level given to authenticated users who are not in the access control list'
,p_version_scn=>'SH256:wtFSXAJO6ZfBIDZaLT-NWeHYfr8jXR6d7K_DuhjTxbQ'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_app_setting(
 p_id=>wwv_flow_imp.id(3415222404442210841)
,p_name=>'FEEDBACK_ATTACHMENTS_YN'
,p_value=>'Y'
,p_is_required=>'N'
,p_valid_values=>'Y, N'
,p_on_upgrade_keep_value=>true
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_version_scn=>'SH256:zBoHxELbCF64JiYwSzQdItfu58AlSVUWmbfwVhVGpyo'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/tabs/standard
begin
null;
end;
/
prompt --application/shared_components/navigation/tabs/parent
begin
null;
end;
/
prompt --application/shared_components/user_interface/lovs/access_roles
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416980983200217406)
,p_lov_name=>'ACCESS_ROLES'
,p_static_id=>'access-roles'
,p_lov_query=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select role_name d, role_id r',
'from APEX_APPL_ACL_ROLES where application_id = :APP_ID ',
'order by 1'))
,p_source_type=>'SQL'
,p_location=>'LOCAL'
,p_return_column_name=>'R'
,p_display_column_name=>'D'
,p_version_scn=>'SH256:hw1yHwou0QVtzlsCnrLSXndSn95AkdZHJv9ZCO7rHeg'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/boolean
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416794697486217173)
,p_lov_name=>'BOOLEAN'
,p_static_id=>'boolean'
,p_lov_query=>'.'||wwv_flow_imp.id(3416794697486217173)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:CnCBOq-zabcz-aPWKwU8C5KDeZy6YuyjvpJoTrTywfI'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416795678654217174)
,p_lov_disp_sequence=>2
,p_lov_disp_value=>'No'
,p_lov_return_value=>'FALSE'
,p_static_id=>'false'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416795072082217173)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Yes'
,p_lov_return_value=>'TRUE'
,p_static_id=>'true'
);
end;
/
prompt --application/shared_components/user_interface/lovs/desktop_theme_styles
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416816742201217204)
,p_lov_name=>'DESKTOP THEME STYLES'
,p_static_id=>'desktop-theme-styles'
,p_lov_query=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select s.name d,',
'       s.theme_style_id r',
'  from apex_application_theme_styles s,',
'       apex_application_themes t',
' where s.application_id = :app_id',
'   and t.application_id = s.application_id',
'   and t.theme_number   = s.theme_number',
'   and t.is_current     = ''Yes''',
' order by 1'))
,p_source_type=>'SQL'
,p_location=>'LOCAL'
,p_return_column_name=>'R'
,p_display_column_name=>'D'
,p_version_scn=>'SH256:BV99rFiD2E3hUCMQwqdJUP9mSBtytAbj6XTz8AGFmsA'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/email_username_format
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416991026268217416)
,p_lov_name=>'EMAIL_USERNAME_FORMAT'
,p_static_id=>'email-username-format'
,p_lov_query=>'.'||wwv_flow_imp.id(3416991026268217416)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:og77UyB456nZ1KlCr4DAkFaNaKZm9jBHGC16mBmSJsk'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416991638628217417)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Email Addresses'
,p_lov_return_value=>'EMAIL'
,p_static_id=>'email'
);
end;
/
prompt --application/shared_components/user_interface/lovs/feedback_rating
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3417013025855217439)
,p_lov_name=>'FEEDBACK_RATING'
,p_static_id=>'feedback-rating'
,p_lov_query=>'.'||wwv_flow_imp.id(3417013025855217439)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:QHID2_AL91pivdhRvWMf8rTxRdNvsqexHwq5MFyhCN4'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417014673698217441)
,p_lov_disp_sequence=>3
,p_lov_disp_value=>'Negative'
,p_lov_return_value=>'1'
,p_static_id=>'1'
,p_lov_template=>'<span title="#DISPLAY_VALUE#" aria-label="#DISPLAY_VALUE#"><span class="fa fa-frown-o fa-2x feedback-negative" aria-hidden="true" ></span></span>'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417014011590217440)
,p_lov_disp_sequence=>2
,p_lov_disp_value=>'Neutral'
,p_lov_return_value=>'2'
,p_static_id=>'2'
,p_lov_template=>'<span title="#DISPLAY_VALUE#" aria-label="#DISPLAY_VALUE#"><span class="fa fa-emoji-neutral fa-2x feedback-neutral" aria-hidden="true" ></span></span>'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417013527057217440)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Positive'
,p_lov_return_value=>'3'
,p_static_id=>'3'
,p_lov_template=>'<span title="#DISPLAY_VALUE#" aria-label="#DISPLAY_VALUE#"><span class="fa fa-smile-o fa-2x feedback-positive" aria-hidden="true" ></span></span>'
);
end;
/
prompt --application/shared_components/user_interface/lovs/feedback_status
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3417028449948217452)
,p_lov_name=>'FEEDBACK_STATUS'
,p_static_id=>'feedback-status'
,p_lov_query=>'.'||wwv_flow_imp.id(3417028449948217452)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:PpuBEbIoOUhSzFsElNFuOJRnL162R3kqFnYCQDsmzNw'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417029021573217453)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'No Action'
,p_lov_return_value=>'0'
,p_static_id=>'0'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417029577518217453)
,p_lov_disp_sequence=>2
,p_lov_disp_value=>'Acknowledged'
,p_lov_return_value=>'1'
,p_static_id=>'1'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417030181976217454)
,p_lov_disp_sequence=>3
,p_lov_disp_value=>'Open'
,p_lov_return_value=>'3'
,p_static_id=>'3'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3417030674615217454)
,p_lov_disp_sequence=>4
,p_lov_disp_value=>'Closed'
,p_lov_return_value=>'4'
,p_static_id=>'4'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_customers_cust_first_name
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3415801030801211387)
,p_lov_name=>'OEHR_CUSTOMERS.CUST_FIRST_NAME'
,p_static_id=>'oehr-customers-cust-first-name'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_CUSTOMERS'
,p_return_column_name=>'CUSTOMER_ID'
,p_display_column_name=>'CUST_FIRST_NAME'
,p_default_sort_column_name=>'CUST_FIRST_NAME'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:0R07nB6DVJIpV1CylY5PTnBemQ1yToSosjZIk6TqV6s'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_departments_department_name
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416027965267213966)
,p_lov_name=>'OEHR_DEPARTMENTS.DEPARTMENT_NAME'
,p_static_id=>'oehr-departments-department-name'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_DEPARTMENTS'
,p_return_column_name=>'DEPARTMENT_ID'
,p_display_column_name=>'DEPARTMENT_NAME'
,p_default_sort_column_name=>'DEPARTMENT_NAME'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:k8xSwZK-MSc6PYMQey2b6PfMoZZxT8eNoCT5oIWKEkU'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_employees_first_name
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3415251217724210934)
,p_lov_name=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_static_id=>'oehr-employees-first-name'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_EMPLOYEES'
,p_return_column_name=>'EMPLOYEE_ID'
,p_display_column_name=>'FIRST_NAME'
,p_default_sort_column_name=>'FIRST_NAME'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:E9c0g14dH5WEcjJUawaPgJbIKn9EiuKWi3cpT3YWvr8'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_jobs_job_title
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416026846248213964)
,p_lov_name=>'OEHR_JOBS.JOB_TITLE'
,p_static_id=>'oehr-jobs-job-title'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_JOBS'
,p_return_column_name=>'JOB_ID'
,p_display_column_name=>'JOB_TITLE'
,p_default_sort_column_name=>'JOB_TITLE'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:JeUvGx9WJ_ZNsfhyRR1ZKBRgsJYOXeBOj0QVgdW7YT4'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_locations_street_address
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416084403068215570)
,p_lov_name=>'OEHR_LOCATIONS.STREET_ADDRESS'
,p_static_id=>'oehr-locations-street-address'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_LOCATIONS'
,p_return_column_name=>'LOCATION_ID'
,p_display_column_name=>'STREET_ADDRESS'
,p_default_sort_column_name=>'STREET_ADDRESS'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:C_-6AJPtO5QCUBY3bPsPDTckkgtRp8N5HPeLBmlnmDs'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/oehr_regions_region_name
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416071442247215081)
,p_lov_name=>'OEHR_REGIONS.REGION_NAME'
,p_static_id=>'oehr-regions-region-name'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'OEHR_REGIONS'
,p_return_column_name=>'REGION_ID'
,p_display_column_name=>'REGION_NAME'
,p_default_sort_column_name=>'REGION_NAME'
,p_default_sort_direction=>'ASC'
,p_version_scn=>'SH256:eWLkI1dgnEoeHlhU6bWzWUNlXDJNyryO6i_xnBIq288'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/timeframe_4_weeks
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416843974512217232)
,p_lov_name=>'TIMEFRAME (4 WEEKS)'
,p_static_id=>'timeframe-4-weeks'
,p_lov_query=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select disp,',
'       val as seconds',
'  from table( apex_util.get_timeframe_lov_data )',
' order by insert_order'))
,p_source_type=>'SQL'
,p_location=>'LOCAL'
,p_return_column_name=>'SECONDS'
,p_display_column_name=>'DISP'
,p_version_scn=>'SH256:MHjq8a1C6UKgUTdUiXoLyw_rytnwJPhwCeLln9D4WW8'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/lovs/user_theme_preference
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416818692901217207)
,p_lov_name=>'USER_THEME_PREFERENCE'
,p_static_id=>'user-theme-preference'
,p_lov_query=>'.'||wwv_flow_imp.id(3416818692901217207)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:svCOQpyt_FwMXtjCj17rqgC9rZFoEhbVqAwu8f6IkL8'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416819052309217208)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Allow all End Users to choose Theme Style'
,p_lov_return_value=>'Yes'
,p_static_id=>'yes'
);
end;
/
prompt --application/shared_components/user_interface/lovs/view_as_report_chart
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(3416930594263217344)
,p_lov_name=>'VIEW_AS_REPORT_CHART'
,p_static_id=>'view-as-report-chart'
,p_lov_query=>'.'||wwv_flow_imp.id(3416930594263217344)||'.'
,p_location=>'STATIC'
,p_version_scn=>'SH256:-NiiYPWYjIc3Pc-aCWde6UlxvjCf8ukbfArqZU7onD4'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416931603549217346)
,p_lov_disp_sequence=>2
,p_lov_disp_value=>'Add Chart Page'
,p_lov_return_value=>'CHART'
,p_static_id=>'chart'
,p_lov_template=>'<span class="fa fa-pie-chart" aria-hidden="true"></span><span class="u-VisuallyHidden">#DISPLAY_VALUE#</span>'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(3416931027161217345)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Add Report Page'
,p_lov_return_value=>'REPORT'
,p_static_id=>'report'
,p_lov_template=>'<span class="fa fa-table" aria-hidden="true"></span><span class="u-VisuallyHidden">#DISPLAY_VALUE#</span>'
);
end;
/
prompt --application/pages/page_groups
begin
wwv_flow_imp_page.create_page_group(
 p_id=>wwv_flow_imp.id(3415223083430210842)
,p_group_name=>'Administration'
,p_static_id=>'administration'
);
wwv_flow_imp_page.create_page_group(
 p_id=>wwv_flow_imp.id(3417097778037217536)
,p_group_name=>'User Settings'
,p_static_id=>'user-settings'
);
end;
/
prompt --application/shared_components/navigation/breadcrumbs/breadcrumb
begin
wwv_flow_imp_shared.create_menu(
 p_id=>wwv_flow_imp.id(3415214906381210815)
,p_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3417068656740217502)
,p_short_name=>'Administration'
,p_static_id=>'administration'
,p_link=>'f?p=&APP_ID.:10000:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>10000
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3415590280159211245)
,p_short_name=>'Customers'
,p_static_id=>'customers'
,p_link=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>3
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071310Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3415249172174210911)
,p_short_name=>'Dashboard'
,p_static_id=>'dashboard'
,p_link=>'f?p=&APP_ID.:2:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>2
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3416037104517213984)
,p_short_name=>'Employees'
,p_static_id=>'employees'
,p_link=>'f?p=&APP_ID.:8:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>8
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3415215164835210816)
,p_short_name=>'Home'
,p_static_id=>'home'
,p_link=>'f?p=&APP_ID.:1:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>1
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3415806296158211399)
,p_short_name=>'Order Search'
,p_static_id=>'order-search'
,p_link=>'f?p=&APP_ID.:5:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>5
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_menu_option(
 p_id=>wwv_flow_imp.id(3416024835806213955)
,p_short_name=>'Orders Calendar'
,p_static_id=>'orders-calendar'
,p_link=>'f?p=&APP_ID.:7:&APP_SESSION.::&DEBUG.:::'
,p_page_id=>7
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/navigation/breadcrumbentry
begin
null;
end;
/
prompt --application/shared_components/user_interface/themes
begin
wwv_flow_imp_shared.create_theme(
 p_id=>wwv_flow_imp.id(3415215820059210817)
,p_theme_id=>42
,p_static_id=>'universal-theme'
,p_theme_name=>'Universal Theme'
,p_theme_internal_name=>'UNIVERSAL_THEME'
,p_version_identifier=>'26.2'
,p_navigation_type=>'L'
,p_nav_bar_type=>'LIST'
,p_is_locked=>false
,p_current_theme_style_id=>4194319937007846
,p_default_page_template=>4075783602716660119
,p_default_dialog_template=>2103835248774687739
,p_error_template=>2104585595298951431
,p_printer_friendly_template=>4075783602716660119
,p_login_template=>2104585595298951431
,p_default_button_template=>4075790603270660137
,p_default_region_template=>4075786578761660127
,p_default_chart_template=>4075786578761660127
,p_default_form_template=>4075786578761660127
,p_default_reportr_template=>4075786578761660127
,p_default_wizard_template=>4075786578761660127
,p_default_menur_template=>2534890969069732905
,p_default_listr_template=>4075786578761660127
,p_default_irr_template=>2103954283454391425
,p_default_report_template=>2542081983073888486
,p_default_label_template=>1612549609962752680
,p_default_menu_template=>4075790987805660140
,p_default_list_template=>4075788786379660133
,p_default_top_nav_list_temp=>2530182346535839887
,p_default_side_nav_list_temp=>2471166859590295591
,p_default_nav_list_position=>'SIDE'
,p_default_dialogbtnr_template=>2129856781885180476
,p_default_dialogr_template=>4504868307683981366
,p_default_option_label=>1612549609962752680
,p_default_required_label=>1612549789555753698
,p_default_navbar_list_template=>2850970698196720012
,p_file_prefix=>nvl(wwv_flow_application_install.get_static_theme_file_prefix(42),'#APEX_FILES#themes/theme_42/26.2/')
,p_files_version=>64
,p_icon_library=>'FONTAPEX'
,p_javascript_file_urls=>wwv_flow_string.join(wwv_flow_t_varchar2(
'#APEX_FILES#libraries/apex/#MIN_DIRECTORY#widget.stickyWidget#MIN#.js?v=#APEX_VERSION#',
'#THEME_FILES#js/theme42#MIN#.js?v=#APEX_VERSION#'))
,p_css_file_urls=>'#THEME_FILES#css/Core#MIN#.css?v=#APEX_VERSION#'
,p_reference_id=>wwv_imp_util.get_subscription_id(4075791579648660165,2000,'universal-theme',8842.262)
,p_version_scn=>'SH256:_ZA2OCAT0oe8zXeYXS4pqku9eJXOHXBko77-CJUyv6E'
,p_version_scn_master=>'SH256:S3Fh7S4ZMPpy-ID1j0RgxJIrTUyM6ZXOJB4KD7haOtc'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/user_interface/theme_style
begin
null;
end;
/
prompt --application/shared_components/user_interface/theme_files
begin
null;
end;
/
prompt --application/shared_components/user_interface/template_opt_groups
begin
null;
end;
/
prompt --application/shared_components/user_interface/template_options
begin
null;
end;
/
prompt --application/shared_components/globalization/language
begin
null;
end;
/
prompt --application/shared_components/globalization/translations
begin
null;
end;
/
prompt --application/shared_components/logic/build_options
begin
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415214257384210814)
,p_build_option_name=>'Commented Out'
,p_static_id=>'commented-out'
,p_build_option_status=>'EXCLUDE'
,p_version_scn=>'SH256:1lQI3DW9n-0ZEGoDXUirkaB0JWCIATVWpJZCTCkODmI'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415219407143210834)
,p_build_option_name=>'Feature: About Page'
,p_static_id=>'feature-about-page'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:XJT0LyDPwECBH8IlgFn2KNvjd0rsRDXoOWkE0Llo7dI'
,p_feature_identifier=>'APPLICATION_ABOUT_PAGE'
,p_build_option_comment=>'About this application page.'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415218790703210834)
,p_build_option_name=>'Feature: Access Control'
,p_static_id=>'feature-access-control'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:oflPhSoxb6RLGIrI0NPG8HuaDVyLNnJobFXxm8ThcXA'
,p_feature_identifier=>'APPLICATION_ACCESS_CONTROL'
,p_build_option_comment=>'Incorporate role based user authentication within your application and manage username mappings to application roles.'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415218884799210834)
,p_build_option_name=>'Feature: Activity Reporting'
,p_static_id=>'feature-activity-reporting'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:lzgblhVTHdsLZ2SVZQtKCpccbHJ-NIdtYcemlW_ATts'
,p_feature_identifier=>'APPLICATION_ACTIVITY_REPORTING'
,p_build_option_comment=>'Include numerous reports and charts on end user activity.'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415219141650210834)
,p_build_option_name=>'Feature: Configuration Options'
,p_static_id=>'feature-configuration-options'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:9DZMtxxhBz9UCnZNQtIbo0Dy2HGKowerd3vWs4_gEhU'
,p_feature_identifier=>'APPLICATION_CONFIGURATION'
,p_build_option_comment=>'Allow application administrators to enable or disable specific functionality, associated with an Oracle APEX build option, from within the application.'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415218930059210834)
,p_build_option_name=>'Feature: Feedback'
,p_static_id=>'feature-feedback'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:4w9c61-62VcsI0g96MpTWgQTDraGR_8MLzAozytdVqo'
,p_feature_identifier=>'APPLICATION_FEEDBACK'
,p_build_option_comment=>'Provide a mechanism for end users to post general comments back to the application administrators and developers.'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3417098023305217537)
,p_build_option_name=>'Feature: Push Notifications'
,p_static_id=>'feature-push-notifications'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:3WlknQG5FntlPjuOlArqfjFp2TNiokODRfRu8mMBFuw'
,p_feature_identifier=>'APPLICATION_PUSH_NOTIFICATIONS'
,p_build_option_comment=>'Allow users to subscribe to push notifications on their devices.'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3415219520831210834)
,p_build_option_name=>'Feature: Theme Style Selection'
,p_static_id=>'feature-theme-style-selection'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:QRbJopHL0jPGfJBmzVDfxlGvtK3A5q4-lkLWnG9Vv6I'
,p_feature_identifier=>'APPLICATION_THEME_STYLE_SELECTION'
,p_build_option_comment=>'Allow administrators to select a default color scheme (theme style) for the application. Administrators can also choose to allow end users to choose their own theme style. '
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_build_option(
 p_id=>wwv_flow_imp.id(3417098503295217537)
,p_build_option_name=>'Feature: User Settings'
,p_static_id=>'feature-user-settings'
,p_build_option_status=>'INCLUDE'
,p_version_scn=>'SH256:JnASmz458-j5t7kNO3o77354WxlsY67o7JM4yPsoWsg'
,p_feature_identifier=>'APPLICATION_USER_SETTINGS'
,p_build_option_comment=>'The user settings page is a drawer that links to all user settings pages.'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/globalization/messages
begin
null;
end;
/
prompt --application/shared_components/globalization/dyntranslations
begin
null;
end;
/
prompt --application/shared_components/security/authentications/oracle_apex_accounts
begin
wwv_flow_imp_shared.create_authentication(
 p_id=>wwv_flow_imp.id(3415214555275210815)
,p_name=>'Oracle APEX Accounts'
,p_static_id=>'oracle-apex-accounts'
,p_scheme_type=>'NATIVE_APEX_ACCOUNTS'
,p_invalid_session_type=>'LOGIN'
,p_use_secure_cookie_yn=>'N'
,p_ras_mode=>0
,p_version_scn=>'SH256:MwlwV9vQNyvTGV3nRFfTrp5n7mJ1Ugme2lUrlsOYuxw'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/shared_components/security/authentications/public
begin
wwv_flow_imp_shared.create_authentication(
 p_id=>wwv_flow_imp.id(3435047377239279134)
,p_name=>'Public'
,p_static_id=>'public'
,p_scheme_type=>'NATIVE_DAD'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'username', 'nobody')).to_clob
,p_use_secure_cookie_yn=>'N'
,p_ras_mode=>0
,p_version_scn=>'SH256:97GbD4lbODSVAAct2GlVU4Fpu-XGdJqVwFW8brAaLiI'
,p_created_on=>wwv_flow_imp.dz('20261014071706Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071800Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/user_interfaces/combined_files
begin
null;
end;
/
prompt --application/pages/page_00000
begin
wwv_flow_imp_page.create_page(
 p_id=>0
,p_name=>'Global Page'
,p_reload_on_submit=>null
,p_warn_on_unsaved_changes=>null
,p_autocomplete_on_off=>'OFF'
,p_protection_level=>'D'
,p_page_component_map=>'14'
,p_created_on=>wwv_flow_imp.dz('20261014071306Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071306Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00001
begin
wwv_flow_imp_page.create_page(
 p_id=>1
,p_name=>'Home'
,p_alias=>'HOME'
,p_step_title=>'Demonstration - HR'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'13'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415238875118210898)
,p_plug_name=>'Demonstration - HR'
,p_static_id=>'demonstration-hr'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2677445476673898083
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_plug_source=>'Generated based on a Sample Dataset!'
,p_plug_query_num_rows=>15
,p_region_image=>'#APP_FILES#icons/app-icon-512.png'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416794009117217172)
,p_plug_name=>'Page Navigation'
,p_static_id=>'page-navigation'
,p_region_template_options=>'#DEFAULT#:t-Region--hideHeader js-addHiddenHeadingRoleDesc:t-Region--noUI:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:u-colors:t-Cards--featured t-Cards--block force-fa-lg:t-Cards--displayIcons:t-Cards--4cols:t-Cards--hideBody:t-Cards--animColorFill'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3416789319697217167)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2890197131116233323
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00002
begin
wwv_flow_imp_page.create_page(
 p_id=>2
,p_name=>'Dashboard'
,p_alias=>'DASHBOARD'
,p_step_title=>'Dashboard'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'04'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415248573683210909)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415247018918210908)
,p_plug_name=>'Order Modes'
,p_static_id=>'order-modes'
,p_region_template_options=>'#DEFAULT#:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>40
,p_plug_new_grid_row=>false
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3415247498171210909)
,p_region_id=>wwv_flow_imp.id(3415247018918210908)
,p_chart_type=>'pie'
,p_lazy_loading=>false
,p_animation_on_display=>'auto'
,p_animation_on_data_change=>'auto'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_value_format_type=>'decimal'
,p_value_decimal_places=>0
,p_value_format_scaling=>'auto'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_pie_other_threshold=>0
,p_pie_selection_effect=>'highlight'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3415247915781210909)
,p_chart_id=>wwv_flow_imp.id(3415247498171210909)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'TABLE'
,p_max_row_count=>20
,p_query_table=>'OEHR_ORDERS'
,p_include_rowid_column=>false
,p_series_type=>'pie'
,p_items_label_column_name=>'ORDER_MODE'
,p_aggregate_function=>'COUNT'
,p_items_label_rendered=>true
,p_items_label_position=>'auto'
,p_items_label_display_as=>'LABEL'
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415245527730210907)
,p_plug_name=>'Product Status'
,p_static_id=>'product-status'
,p_region_template_options=>'#DEFAULT#:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3415245906226210907)
,p_region_id=>wwv_flow_imp.id(3415245527730210907)
,p_chart_type=>'pie'
,p_lazy_loading=>false
,p_animation_on_display=>'auto'
,p_animation_on_data_change=>'auto'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_value_format_type=>'decimal'
,p_value_decimal_places=>0
,p_value_format_scaling=>'auto'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_pie_other_threshold=>0
,p_pie_selection_effect=>'highlight'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3415246435636210908)
,p_chart_id=>wwv_flow_imp.id(3415245906226210907)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'TABLE'
,p_max_row_count=>20
,p_query_table=>'OEHR_PRODUCTS'
,p_include_rowid_column=>false
,p_series_type=>'pie'
,p_items_label_column_name=>'PRODUCT_STATUS'
,p_aggregate_function=>'COUNT'
,p_items_label_rendered=>true
,p_items_label_position=>'auto'
,p_items_label_display_as=>'LABEL'
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415240168694210902)
,p_plug_name=>'Total Customer Orders'
,p_static_id=>'total-customer-orders'
,p_region_template_options=>'#DEFAULT#:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3415240541772210903)
,p_region_id=>wwv_flow_imp.id(3415240168694210902)
,p_chart_type=>'bar'
,p_lazy_loading=>false
,p_animation_on_display=>'auto'
,p_animation_on_data_change=>'auto'
,p_orientation=>'vertical'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_sorting=>'label-asc'
,p_fill_multi_series_gaps=>true
,p_tooltip_rendered=>'Y'
,p_show_series_name=>true
,p_show_group_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3415242239853210904)
,p_chart_id=>wwv_flow_imp.id(3415240541772210903)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select ( select l."CUST_FIRST_NAME" from "OEHR_CUSTOMERS" l where l."CUSTOMER_ID" = c."CUSTOMER_ID") "CUSTOMER_ID", ',
'       sum(c."ORDER_TOTAL") value',
'  from "OEHR_ORDERS" c',
' where c."ORDER_TOTAL" is not null',
' group by c."CUSTOMER_ID"',
' order by 2 desc'))
,p_max_row_count=>20
,p_series_type=>'bar'
,p_items_value_column_name=>'VALUE'
,p_items_label_column_name=>'CUSTOMER_ID'
,p_items_label_rendered=>false
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3415241026169210903)
,p_chart_id=>wwv_flow_imp.id(3415240541772210903)
,p_static_id=>'x'
,p_axis=>'x'
,p_is_rendered=>'on'
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_tick_label_rotation=>'auto'
,p_tick_label_position=>'outside'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3415241682234210904)
,p_chart_id=>wwv_flow_imp.id(3415240541772210903)
,p_static_id=>'y'
,p_axis=>'y'
,p_is_rendered=>'on'
,p_format_type=>'decimal'
,p_decimal_places=>0
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_position=>'auto'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415242817083210905)
,p_plug_name=>'Total Sales Rep Orders'
,p_static_id=>'total-sales-rep-orders'
,p_region_template_options=>'#DEFAULT#:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>20
,p_plug_new_grid_row=>false
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3415243231613210905)
,p_region_id=>wwv_flow_imp.id(3415242817083210905)
,p_chart_type=>'bar'
,p_lazy_loading=>false
,p_animation_on_display=>'auto'
,p_animation_on_data_change=>'auto'
,p_orientation=>'vertical'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_sorting=>'label-asc'
,p_fill_multi_series_gaps=>true
,p_tooltip_rendered=>'Y'
,p_show_series_name=>true
,p_show_group_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3415244931864210906)
,p_chart_id=>wwv_flow_imp.id(3415243231613210905)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select ( select l."FIRST_NAME" from "OEHR_EMPLOYEES" l where l."EMPLOYEE_ID" = c."SALES_REP_ID") "SALES_REP_ID", ',
'       sum(c."ORDER_TOTAL") value',
'  from "OEHR_ORDERS" c',
' where c."ORDER_TOTAL" is not null',
' group by c."SALES_REP_ID"',
' order by 2 desc'))
,p_max_row_count=>20
,p_series_type=>'bar'
,p_items_value_column_name=>'VALUE'
,p_items_label_column_name=>'SALES_REP_ID'
,p_items_label_rendered=>false
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3415243731267210906)
,p_chart_id=>wwv_flow_imp.id(3415243231613210905)
,p_static_id=>'x'
,p_axis=>'x'
,p_is_rendered=>'on'
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_tick_label_rotation=>'auto'
,p_tick_label_position=>'outside'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3415244304734210906)
,p_chart_id=>wwv_flow_imp.id(3415243231613210905)
,p_static_id=>'y'
,p_axis=>'y'
,p_is_rendered=>'on'
,p_format_type=>'decimal'
,p_decimal_places=>0
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_position=>'auto'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00003
begin
wwv_flow_imp_page.create_page(
 p_id=>3
,p_name=>'Customers'
,p_alias=>'CUSTOMERS'
,p_step_title=>'Customers'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>2530071015796209513
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'22'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415587765117211244)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071310Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415253588104210939)
,p_plug_name=>'Button Bar'
,p_static_id=>'button-bar'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--noPadding:t-ButtonRegion--noUI'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_source=>'<div id="active_facets"></div>'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415250433785210930)
,p_plug_name=>'Search'
,p_static_id=>'search'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>10
,p_plug_grid_column_span=>4
,p_plug_display_point=>'REGION_POSITION_02'
,p_plug_item_display_point=>'ABOVE'
,p_plug_source_type=>'NATIVE_FACETED_SEARCH'
,p_filtered_region_id=>wwv_flow_imp.id(3415250346131210930)
,p_landmark_label=>'Filters'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'batch_facet_search', 'N',
  'compact_numbers_threshold', '10000',
  'current_facets_selector', '#active_facets',
  'display_chart_for_top_n_values', '10',
  'show_charts', 'Y',
  'show_current_facets', 'E',
  'show_total_row_count', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415251643034210935)
,p_name=>'P3_ACCOUNT_MGR_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Account Mgr'
,p_source=>'ACCOUNT_MGR_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415252078753210935)
,p_name=>'P3_COUNTRY_ID'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Country ID'
,p_source=>'COUNTRY_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_lov_sort_direction=>'ASC'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415253237546210939)
,p_name=>'P3_CREDIT_LIMIT'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Credit Limit'
,p_source=>'CREDIT_LIMIT'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_RANGE'
,p_lov=>'STATIC2:<300;|300,300 - 1#G#000;300|1000,1#G#000 - 2#G#000;1000|2000,2#G#000 - 3#G#000;2000|3000,>=3#G#000;3000|'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'manual_entry', 'N',
  'select_multiple', 'Y')).to_clob
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415252877558210936)
,p_name=>'P3_NLS_LANGUAGE'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Nls Language'
,p_source=>'NLS_LANGUAGE'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_lov_sort_direction=>'ASC'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415252483777210936)
,p_name=>'P3_NLS_TERRITORY'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Nls Territory'
,p_source=>'NLS_TERRITORY'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_lov_sort_direction=>'ASC'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415250924948210934)
,p_name=>'P3_SEARCH'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3415250433785210930)
,p_prompt=>'Search'
,p_source=>'NLS_LANGUAGE,CUST_FIRST_NAME,CUST_LAST_NAME,STREET_ADDRESS,POSTAL_CODE,CITY,STATE_PROVINCE,COUNTRY_ID,PHONE_NUMBER'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_SEARCH'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'input_field', 'FACET',
  'search_type', 'ROW')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3415250346131210930)
,p_name=>'Customers'
,p_static_id=>'search-results'
,p_template=>4075786578761660127
,p_display_sequence=>20
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--staticRowColors:t-Report--rowHighlight:t-Report--inline:t-Report--hideNoPagination'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_CUSTOMERS'
,p_include_rowid_column=>false
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>50
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_query_row_count_max=>100000
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415568305547211241)
,p_query_column_id=>14
,p_column_alias=>'ACCOUNT_MGR_ID'
,p_column_display_sequence=>14
,p_column_heading=>'Account Mgr'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_display_as=>'TEXT_FROM_LOV_ESC'
,p_named_lov=>wwv_flow_imp.id(3415251217724210934)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415530056628211234)
,p_query_column_id=>6
,p_column_alias=>'CITY'
,p_column_display_sequence=>6
,p_column_heading=>'City'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415543385734211236)
,p_query_column_id=>8
,p_column_alias=>'COUNTRY_ID'
,p_column_display_sequence=>8
,p_column_heading=>'Country ID'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415561073991211240)
,p_query_column_id=>12
,p_column_alias=>'CREDIT_LIMIT'
,p_column_display_sequence=>12
,p_column_heading=>'Credit Limit'
,p_hidden_column=>'Y'
,p_derived_column=>'N'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415504403586211230)
,p_query_column_id=>1
,p_column_alias=>'CUSTOMER_ID'
,p_column_display_sequence=>0
,p_column_heading=>'<span class="u-VisuallyHidden">Edit</span>'
,p_column_link=>'f?p=&APP_ID.:4:&APP_SESSION.::&DEBUG.:RP:P4_CUSTOMER_ID:\#CUSTOMER_ID#\'
,p_column_linktext=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_column_alignment=>'CENTER'
,p_report_column_required_role=>wwv_flow_imp.id(3415221674985210839)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415562670054211240)
,p_query_column_id=>13
,p_column_alias=>'CUST_EMAIL'
,p_column_display_sequence=>13
,p_column_heading=>'Cust Email'
,p_default_sort_column_sequence=>1
,p_hidden_column=>'Y'
,p_derived_column=>'N'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415511304155211231)
,p_query_column_id=>2
,p_column_alias=>'CUST_FIRST_NAME'
,p_column_display_sequence=>2
,p_column_heading=>'Cust First Name'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415516858255211232)
,p_query_column_id=>3
,p_column_alias=>'CUST_LAST_NAME'
,p_column_display_sequence=>3
,p_column_heading=>'Cust Last Name'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415551603841211238)
,p_query_column_id=>10
,p_column_alias=>'NLS_LANGUAGE'
,p_column_display_sequence=>10
,p_column_heading=>'Nls Language'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415558190471211239)
,p_query_column_id=>11
,p_column_alias=>'NLS_TERRITORY'
,p_column_display_sequence=>11
,p_column_heading=>'Nls Territory'
,p_default_sort_column_sequence=>1
,p_hidden_column=>'Y'
,p_derived_column=>'N'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415549516681211237)
,p_query_column_id=>9
,p_column_alias=>'PHONE_NUMBER'
,p_column_display_sequence=>9
,p_column_heading=>'Phone Number'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415526256776211234)
,p_query_column_id=>5
,p_column_alias=>'POSTAL_CODE'
,p_column_display_sequence=>5
,p_column_heading=>'Postal Code'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415534351228211235)
,p_query_column_id=>7
,p_column_alias=>'STATE_PROVINCE'
,p_column_display_sequence=>7
,p_column_heading=>'State Province'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3415522696788211233)
,p_query_column_id=>4
,p_column_alias=>'STREET_ADDRESS'
,p_column_display_sequence=>4
,p_column_heading=>'Street Address'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415575118771211242)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3415250346131210930)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:4:&APP_SESSION.::&DEBUG.:4::'
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071310Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415253987417210941)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3415253588104210939)
,p_button_name=>'RESET'
,p_static_id=>'reset'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI:t-Button--iconLeft'
,p_button_template_id=>2086257187394300437
,p_button_image_alt=>'Reset'
,p_button_position=>'NEXT'
,p_button_redirect_url=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:RR,3::'
,p_icon_css_classes=>'fa-undo'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3415577704734211243)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3415250346131210930)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071310Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3415580977013211243)
,p_event_id=>wwv_flow_imp.id(3415577704734211243)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3415250346131210930)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071310Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00004
begin
wwv_flow_imp_page.create_page(
 p_id=>4
,p_name=>'Customer'
,p_alias=>'CUSTOMER'
,p_page_mode=>'MODAL'
,p_step_title=>'Customer'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>1664614232864994871
,p_page_template_options=>'#DEFAULT#:js-dialog-class-t-Drawer--pullOutEnd'
,p_required_role=>wwv_flow_imp.id(3415221674985210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415794336005211374)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415593133578211246)
,p_plug_name=>'Customer'
,p_static_id=>'customer'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_CUSTOMERS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071310Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415794788146211374)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3415794336005211374)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3415795208971211375)
,p_button_id=>wwv_flow_imp.id(3415794788146211374)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415796539691211376)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3415794336005211374)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P4_CUSTOMER_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415795746105211375)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3415794336005211374)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P4_CUSTOMER_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415796196991211376)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3415794336005211374)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P4_CUSTOMER_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415789789518211369)
,p_name=>'P4_ACCOUNT_MGR_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>140
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Account Mgr'
,p_source=>'ACCOUNT_MGR_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415786550724211366)
,p_name=>'P4_CITY'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'City'
,p_source=>'CITY'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>30
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415787374236211367)
,p_name=>'P4_COUNTRY_ID'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>80
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Country ID'
,p_source=>'COUNTRY_ID'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>2
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415788982786211368)
,p_name=>'P4_CREDIT_LIMIT'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>120
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Credit Limit'
,p_source=>'CREDIT_LIMIT'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415599368683211247)
,p_name=>'P4_CUSTOMER_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Customer ID'
,p_source=>'CUSTOMER_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415789328949211369)
,p_name=>'P4_CUST_EMAIL'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>130
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Cust Email'
,p_source=>'CUST_EMAIL'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>30
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415784992877211364)
,p_name=>'P4_CUST_FIRST_NAME'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Cust First Name'
,p_source=>'CUST_FIRST_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>20
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415785313710211365)
,p_name=>'P4_CUST_LAST_NAME'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Cust Last Name'
,p_source=>'CUST_LAST_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>20
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415788101048211368)
,p_name=>'P4_NLS_LANGUAGE'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>100
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Nls Language'
,p_source=>'NLS_LANGUAGE'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>3
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415788546203211368)
,p_name=>'P4_NLS_TERRITORY'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>110
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Nls Territory'
,p_source=>'NLS_TERRITORY'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>30
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415787734073211367)
,p_name=>'P4_PHONE_NUMBER'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>90
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Phone Number'
,p_source=>'PHONE_NUMBER'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>25
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415786140654211366)
,p_name=>'P4_POSTAL_CODE'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Postal Code'
,p_source=>'POSTAL_CODE'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>10
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415786973783211366)
,p_name=>'P4_STATE_PROVINCE'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>70
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'State Province'
,p_source=>'STATE_PROVINCE'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>10
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415785734035211365)
,p_name=>'P4_STREET_ADDRESS'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_item_source_plug_id=>wwv_flow_imp.id(3415593133578211246)
,p_prompt=>'Street Address'
,p_source=>'STREET_ADDRESS'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>40
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415797711538211377)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3415797711538211377
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415796989057211376)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3415593133578211246)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Customer'
,p_static_id=>'initialize-form-customer'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3415796989057211376
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415797306585211377)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3415593133578211246)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Customer'
,p_static_id=>'process-form-customer'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3415797306585211377
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00005
begin
wwv_flow_imp_page.create_page(
 p_id=>5
,p_name=>'Order Search'
,p_alias=>'ORDER-SEARCH'
,p_step_title=>'Order Search'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>2530071015796209513
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'22'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415805633475211398)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415803340643211392)
,p_plug_name=>'Button Bar'
,p_static_id=>'button-bar'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--noPadding:t-ButtonRegion--noUI'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_source=>'<div id="active_facets"></div>'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415800118688211384)
,p_plug_name=>'Search'
,p_static_id=>'search'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>10
,p_plug_grid_column_span=>4
,p_plug_display_point=>'REGION_POSITION_02'
,p_plug_item_display_point=>'ABOVE'
,p_plug_source_type=>'NATIVE_FACETED_SEARCH'
,p_filtered_region_id=>wwv_flow_imp.id(3415800006956211384)
,p_landmark_label=>'Filters'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'batch_facet_search', 'N',
  'compact_numbers_threshold', '10000',
  'current_facets_selector', '#active_facets',
  'display_chart_for_top_n_values', '10',
  'show_charts', 'Y',
  'show_current_facets', 'E',
  'show_total_row_count', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415801476296211388)
,p_name=>'P5_CUSTOMER_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Customer'
,p_source=>'CUSTOMER_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_CUSTOMERS.CUST_FIRST_NAME'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415803082977211392)
,p_name=>'P5_ORDER_MODE'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Order Mode'
,p_source=>'ORDER_MODE'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_RADIOGROUP'
,p_lov_sort_direction=>'ASC'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'hide_radio_buttons', 'N')).to_clob
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'D'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>false
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415802636003211391)
,p_name=>'P5_ORDER_STATUS'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Order Status'
,p_source=>'ORDER_STATUS'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_RANGE'
,p_lov=>'STATIC2:<2;|2,2 - 4;2|4,4 - 6;4|6,6 - 8;6|8,>=8;8|'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'manual_entry', 'N',
  'select_multiple', 'Y')).to_clob
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415801805204211389)
,p_name=>'P5_ORDER_TOTAL'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Order Total'
,p_source=>'ORDER_TOTAL'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_RANGE'
,p_lov=>'STATIC2:<2#G#000;|2000,2#G#000 - 10#G#000;2000|10000,10#G#000 - 20#G#000;10000|20000,20#G#000 - 40#G#000;20000|40000,>=40#G#000;40000|'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'manual_entry', 'N',
  'select_multiple', 'Y')).to_clob
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415802254952211390)
,p_name=>'P5_SALES_REP_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Sales Rep'
,p_source=>'SALES_REP_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415800741459211386)
,p_name=>'P5_SEARCH'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3415800118688211384)
,p_prompt=>'Search'
,p_source=>'ORDER_MODE,CUSTOMER_ID,SALES_REP_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_SEARCH'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'input_field', 'FACET',
  'search_type', 'ROW')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415800006956211384)
,p_plug_name=>'Search Results'
,p_static_id=>'search-results'
,p_region_template_options=>'#DEFAULT#:t-CardsRegion--hideHeader js-addHiddenHeadingRoleDesc'
,p_plug_template=>2076152157930740558
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select "ORDER_ID",',
'       "ORDER_DATE",',
'       "ORDER_MODE",',
'       "CUSTOMER_ID",',
'       ( select l1."CUST_FIRST_NAME" from "OEHR_CUSTOMERS" l1 where l1."CUSTOMER_ID" = m."CUSTOMER_ID") "CUSTOMER_ID_L$1",',
'       "ORDER_STATUS",',
'       "ORDER_TOTAL",',
'       "SALES_REP_ID",',
'       ( select l2."FIRST_NAME" from "OEHR_EMPLOYEES" l2 where l2."EMPLOYEE_ID" = m."SALES_REP_ID") "SALES_REP_ID_L$2",',
'       "PROMOTION_ID"',
'from "OEHR_ORDERS" m'))
,p_query_order_by_type=>'ITEM'
,p_query_order_by=>'{ "itemName": "P5_ORDER_BY", "orderBys": [{"key":"CUSTOMER_ID_L$1","expr":"\"CUSTOMER_ID_L$1\" asc"},{"key":"ORDER_DATE","expr":"\"ORDER_DATE\" asc"},{"key":"ORDER_MODE","expr":"\"ORDER_MODE\" asc"}]}'
,p_lazy_loading=>false
,p_plug_source_type=>'NATIVE_CARDS'
,p_plug_query_num_rows_type=>'SCROLL'
,p_show_total_row_count=>false
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_card(
 p_id=>wwv_flow_imp.id(3415804489262211395)
,p_region_id=>wwv_flow_imp.id(3415800006956211384)
,p_layout_type=>'GRID'
,p_title_adv_formatting=>false
,p_title_column_name=>'CUSTOMER_ID_L$1'
,p_sub_title_adv_formatting=>false
,p_body_adv_formatting=>false
,p_body_column_name=>'ORDER_DATE'
,p_second_body_adv_formatting=>false
,p_icon_source_type=>'INITIALS'
,p_icon_class_column_name=>'CUSTOMER_ID_L$1'
,p_icon_position=>'START'
,p_badge_column_name=>'ORDER_MODE'
,p_media_adv_formatting=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415803789273211393)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3415803340643211392)
,p_button_name=>'RESET'
,p_static_id=>'reset'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI:t-Button--iconLeft'
,p_button_template_id=>2086257187394300437
,p_button_image_alt=>'Reset'
,p_button_position=>'NEXT'
,p_button_redirect_url=>'f?p=&APP_ID.:5:&APP_SESSION.::&DEBUG.:RR,5::'
,p_icon_css_classes=>'fa-undo'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415805377932211397)
,p_name=>'P5_ORDER_BY'
,p_is_required=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3415800006956211384)
,p_item_display_point=>'ORDER_BY_ITEM'
,p_item_default=>'CUSTOMER_ID_L$1'
,p_prompt=>'Order By'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_lov=>'STATIC2:Customer Id L$1;CUSTOMER_ID_L$1,Order Date;ORDER_DATE,Order Mode;ORDER_MODE'
,p_cHeight=>1
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_warn_on_unsaved_changes=>'I'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00006
begin
wwv_flow_imp_page.create_page(
 p_id=>6
,p_name=>'Orders'
,p_alias=>'ORDERS'
,p_step_title=>'Orders'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'21'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415807382653211401)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--noPadding:t-ButtonRegion--noUI'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416009633970213925)
,p_plug_name=>'Order Items'
,p_static_id=>'oehr-order-items'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_ORDER_ITEMS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IG'
,p_master_region_id=>wwv_flow_imp.id(3415808120744211404)
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_created_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416011529352213934)
,p_name=>'APEX$ROW_ACTION'
,p_session_state_data_type=>'VARCHAR2'
,p_item_type=>'NATIVE_ROW_ACTION'
,p_display_sequence=>20
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416011062836213932)
,p_name=>'APEX$ROW_SELECTOR'
,p_session_state_data_type=>'VARCHAR2'
,p_item_type=>'NATIVE_ROW_SELECTOR'
,p_display_sequence=>10
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'enable_multi_select', 'Y',
  'hide_control', 'N',
  'show_select_all', 'Y')).to_clob
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416013601855213938)
,p_name=>'LINE_ITEM_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'LINE_ITEM_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_HIDDEN'
,p_heading=>'Line Item ID'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>40
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_is_required=>true
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416012696620213936)
,p_name=>'ORDER_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_HIDDEN'
,p_heading=>'Order'
,p_display_sequence=>30
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_use_as_row_header=>false
,p_is_primary_key=>false
,p_parent_column_id=>wwv_flow_imp.id(3415811005843211412)
,p_duplicate_value=>true
,p_include_in_export=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416017663203213946)
,p_name=>'ORDER_ITEM_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_ITEM_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>true
,p_item_type=>'NATIVE_HIDDEN'
,p_heading=>'Order Item ID'
,p_display_sequence=>80
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_use_as_row_header=>false
,p_is_primary_key=>true
,p_include_in_export=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416014667418213939)
,p_name=>'PRODUCT_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'PRODUCT_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Product'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>50
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_is_required=>true
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416016647711213944)
,p_name=>'QUANTITY'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'QUANTITY'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Quantity'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>70
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3416015646292213942)
,p_name=>'UNIT_PRICE'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'UNIT_PRICE'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Unit Price'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>60
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990D0'
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_interactive_grid(
 p_id=>wwv_flow_imp.id(3416009736268213928)
,p_internal_uid=>3416009736268213928
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_add_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_update_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_delete_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_lost_update_check_type=>'VALUES'
,p_add_row_if_empty=>true
,p_lazy_loading=>false
,p_requires_filter=>false
,p_select_first_row=>true
,p_fixed_row_height=>true
,p_pagination_type=>'SET'
,p_show_total_row_count=>true
,p_show_toolbar=>true
,p_toolbar_buttons=>'SEARCH_COLUMN:SEARCH_FIELD:ACTIONS_MENU:RESET'
,p_enable_save_public_report=>false
,p_enable_subscriptions=>true
,p_enable_flashback=>true
,p_define_chart_view=>true
,p_enable_download=>true
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>true
,p_fixed_header=>'PAGE'
,p_show_icon_view=>false
,p_show_detail_view=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_ig_report(
 p_id=>wwv_flow_imp.id(3416010543891213931)
,p_interactive_grid_id=>wwv_flow_imp.id(3416009736268213928)
,p_static_id=>'primary'
,p_type=>'PRIMARY'
,p_default_view=>'GRID'
,p_rows_per_page=>10
,p_show_row_number=>false
,p_settings_area_expanded=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_ig_report_view(
 p_id=>wwv_flow_imp.id(3416010681244213931)
,p_report_id=>wwv_flow_imp.id(3416010543891213931)
,p_view_type=>'GRID'
,p_stretch_columns=>true
,p_srv_exclude_null_values=>false
,p_srv_only_display_columns=>true
,p_edit_mode=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416012173127213935)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>0
,p_column_id=>wwv_flow_imp.id(3416011529352213934)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416013143164213937)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>1
,p_column_id=>wwv_flow_imp.id(3416012696620213936)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416014125030213939)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>2
,p_column_id=>wwv_flow_imp.id(3416013601855213938)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416015156758213941)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>3
,p_column_id=>wwv_flow_imp.id(3416014667418213939)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416016129629213943)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>4
,p_column_id=>wwv_flow_imp.id(3416015646292213942)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416017171225213945)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>5
,p_column_id=>wwv_flow_imp.id(3416016647711213944)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3416018155143213947)
,p_view_id=>wwv_flow_imp.id(3416010681244213931)
,p_display_seq=>6
,p_column_id=>wwv_flow_imp.id(3416017663203213946)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415808120744211404)
,p_plug_name=>'Orders'
,p_static_id=>'oehr-orders'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_ORDERS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IG'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415810057335211410)
,p_name=>'APEX$ROW_ACTION'
,p_session_state_data_type=>'VARCHAR2'
,p_item_type=>'NATIVE_ROW_ACTION'
,p_display_sequence=>20
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415809504810211408)
,p_name=>'APEX$ROW_SELECTOR'
,p_session_state_data_type=>'VARCHAR2'
,p_item_type=>'NATIVE_ROW_SELECTOR'
,p_display_sequence=>10
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'enable_multi_select', 'Y',
  'hide_control', 'N',
  'show_select_all', 'Y')).to_clob
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415814086760211419)
,p_name=>'CUSTOMER_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'CUSTOMER_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Customer'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>60
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_is_required=>true
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415812058108211414)
,p_name=>'ORDER_DATE'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_DATE'
,p_data_type=>'TIMESTAMP_TZ'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_TEXT_FIELD'
,p_heading=>'Order Date'
,p_heading_alignment=>'LEFT'
,p_display_sequence=>40
,p_value_alignment=>'LEFT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'trim_spaces', 'BOTH')).to_clob
,p_is_required=>true
,p_enable_filter=>true
,p_filter_date_ranges=>'ALL'
,p_filter_lov_type=>'DISTINCT'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415811005843211412)
,p_name=>'ORDER_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>true
,p_item_type=>'NATIVE_HIDDEN'
,p_heading=>'Order ID'
,p_display_sequence=>30
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_use_as_row_header=>false
,p_is_primary_key=>true
,p_include_in_export=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415813002953211417)
,p_name=>'ORDER_MODE'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_MODE'
,p_data_type=>'VARCHAR2'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_TEXT_FIELD'
,p_heading=>'Order Mode'
,p_heading_alignment=>'LEFT'
,p_display_sequence=>50
,p_value_alignment=>'LEFT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'trim_spaces', 'BOTH')).to_clob
,p_is_required=>false
,p_max_length=>8
,p_enable_filter=>true
,p_filter_operators=>'C:S:CASE_INSENSITIVE:REGEXP'
,p_filter_text_case=>'MIXED'
,p_filter_exact_match=>true
,p_filter_lov_type=>'DISTINCT'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415815003882211421)
,p_name=>'ORDER_STATUS'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_STATUS'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Order Status'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>70
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415816084114211423)
,p_name=>'ORDER_TOTAL'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'ORDER_TOTAL'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Order Total'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>80
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415818006430211427)
,p_name=>'PROMOTION_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'PROMOTION_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_HIDDEN'
,p_heading=>'Promotion ID'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>100
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_region_column(
 p_id=>wwv_flow_imp.id(3415817070784211425)
,p_name=>'SALES_REP_ID'
,p_source_type=>'DB_COLUMN'
,p_source_expression=>'SALES_REP_ID'
,p_data_type=>'NUMBER'
,p_session_state_data_type=>'VARCHAR2'
,p_is_query_only=>false
,p_item_type=>'NATIVE_NUMBER_FIELD'
,p_heading=>'Sales Rep'
,p_heading_alignment=>'RIGHT'
,p_display_sequence=>90
,p_value_alignment=>'RIGHT'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_is_required=>false
,p_enable_filter=>true
,p_filter_lov_type=>'NONE'
,p_use_as_row_header=>false
,p_enable_sort_group=>true
,p_enable_control_break=>true
,p_enable_hide=>true
,p_is_primary_key=>false
,p_duplicate_value=>true
,p_include_in_export=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_interactive_grid(
 p_id=>wwv_flow_imp.id(3415808236674211404)
,p_internal_uid=>3415808236674211404
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_add_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_update_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_delete_authorization_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_lost_update_check_type=>'VALUES'
,p_add_row_if_empty=>true
,p_lazy_loading=>false
,p_requires_filter=>false
,p_select_first_row=>true
,p_fixed_row_height=>true
,p_pagination_type=>'SET'
,p_show_total_row_count=>true
,p_show_toolbar=>true
,p_toolbar_buttons=>'SEARCH_COLUMN:SEARCH_FIELD:ACTIONS_MENU:RESET'
,p_enable_save_public_report=>false
,p_enable_subscriptions=>true
,p_enable_flashback=>true
,p_define_chart_view=>true
,p_enable_download=>true
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>true
,p_fixed_header=>'PAGE'
,p_show_icon_view=>false
,p_show_detail_view=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_ig_report(
 p_id=>wwv_flow_imp.id(3415809012917211407)
,p_interactive_grid_id=>wwv_flow_imp.id(3415808236674211404)
,p_static_id=>'primary'
,p_type=>'PRIMARY'
,p_default_view=>'GRID'
,p_rows_per_page=>10
,p_show_row_number=>false
,p_settings_area_expanded=>true
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_ig_report_view(
 p_id=>wwv_flow_imp.id(3415809180230211407)
,p_report_id=>wwv_flow_imp.id(3415809012917211407)
,p_view_type=>'GRID'
,p_stretch_columns=>true
,p_srv_exclude_null_values=>false
,p_srv_only_display_columns=>true
,p_edit_mode=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415810589220211412)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>0
,p_column_id=>wwv_flow_imp.id(3415810057335211410)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415811592033211414)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>1
,p_column_id=>wwv_flow_imp.id(3415811005843211412)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415812523803211416)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>2
,p_column_id=>wwv_flow_imp.id(3415812058108211414)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415813518360211419)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>3
,p_column_id=>wwv_flow_imp.id(3415813002953211417)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415814583032211421)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>4
,p_column_id=>wwv_flow_imp.id(3415814086760211419)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415815526739211423)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>5
,p_column_id=>wwv_flow_imp.id(3415815003882211421)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415816590945211425)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>6
,p_column_id=>wwv_flow_imp.id(3415816084114211423)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415817524605211427)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>7
,p_column_id=>wwv_flow_imp.id(3415817070784211425)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_ig_report_column(
 p_id=>wwv_flow_imp.id(3415818539699211429)
,p_view_id=>wwv_flow_imp.id(3415809180230211407)
,p_display_seq=>8
,p_column_id=>wwv_flow_imp.id(3415818006430211427)
,p_is_visible=>true
,p_is_frozen=>false
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415807746717211403)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3415807382653211401)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Save'
,p_button_position=>'EDIT'
,p_security_scheme=>wwv_flow_imp.id(3415221674985210839)
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416018654535213948)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416009633970213925)
,p_process_type=>'NATIVE_IG_DML'
,p_process_name=>'OEHR_ORDER_ITEMS - Save Interactive Grid Data'
,p_static_id=>'oehr-order-items-save-interactive-grid-data'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3415807746717211403)
,p_internal_uid=>3416018654535213948
,p_created_on=>wwv_flow_imp.dz('20261014071337Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071337Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415819033806211430)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3415808120744211404)
,p_process_type=>'NATIVE_IG_DML'
,p_process_name=>'OEHR_ORDERS - Save Interactive Grid Data'
,p_static_id=>'oehr-orders-save-interactive-grid-data'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3415807746717211403)
,p_internal_uid=>3415819033806211430
,p_created_on=>wwv_flow_imp.dz('20261014071312Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071312Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00007
begin
wwv_flow_imp_page.create_page(
 p_id=>7
,p_name=>'Orders Calendar'
,p_alias=>'ORDERS-CALENDAR'
,p_step_title=>'Orders Calendar'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'08'
,p_created_on=>wwv_flow_imp.dz('20261014071337Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416024212373213955)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416023983121213953)
,p_plug_name=>'Orders Calendar'
,p_static_id=>'orders-calendar'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_ORDERS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_CSS_CALENDAR'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'additional_calendar_views', 'list:navigation',
  'display_column', 'ORDER_DATE',
  'event_sorting', 'AUTOMATIC',
  'maximum_events_day', '10',
  'multiple_line_event', 'Y',
  'responsive_list_view', 'Y',
  'show_time', 'N',
  'show_tooltip', 'Y',
  'show_weekend', 'Y',
  'start_date_column', 'ORDER_DATE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00008
begin
wwv_flow_imp_page.create_page(
 p_id=>8
,p_name=>'Employees'
,p_alias=>'EMPLOYEES'
,p_step_title=>'Employees'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>2530071015796209513
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'22'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416036561438213983)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416029455349213969)
,p_plug_name=>'Button Bar'
,p_static_id=>'button-bar'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--noPadding:t-ButtonRegion--noUI'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_source=>'<div id="active_facets"></div>'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416026017297213961)
,p_plug_name=>'Search'
,p_static_id=>'search'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>10
,p_plug_grid_column_span=>4
,p_plug_display_point=>'REGION_POSITION_02'
,p_plug_item_display_point=>'ABOVE'
,p_plug_source_type=>'NATIVE_FACETED_SEARCH'
,p_filtered_region_id=>wwv_flow_imp.id(3416025904706213961)
,p_landmark_label=>'Filters'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'batch_facet_search', 'N',
  'compact_numbers_threshold', '10000',
  'current_facets_selector', '#active_facets',
  'display_chart_for_top_n_values', '10',
  'show_charts', 'Y',
  'show_current_facets', 'E',
  'show_total_row_count', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416028732870213968)
,p_name=>'P8_COMMISSION_PCT'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'Commission Percent'
,p_source=>'COMMISSION_PCT'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_RANGE'
,p_lov=>'STATIC2:<0#D#15;|.15,0#D#15 - 0#D#2;.15|.2,0#D#2 - 0#D#25;.2|.25,0#D#25 - 0#D#3;.25|.3,>=0#D#3;.3|'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'manual_entry', 'N',
  'select_multiple', 'Y')).to_clob
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416028371892213967)
,p_name=>'P8_DEPARTMENT_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'Department'
,p_source=>'DEPARTMENT_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_DEPARTMENTS.DEPARTMENT_NAME'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416029195230213969)
,p_name=>'P8_FIRST_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'First Name'
,p_source=>'FIRST_NAME'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_lov_sort_direction=>'ASC'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416027260283213965)
,p_name=>'P8_JOB_ID'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'Job'
,p_source=>'JOB_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_JOBS.JOB_TITLE'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416027600441213966)
,p_name=>'P8_MANAGER_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'Manager'
,p_source=>'MANAGER_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_fc_collapsible=>false
,p_fc_compute_counts=>true
,p_fc_show_counts=>true
,p_fc_zero_count_entries=>'H'
,p_fc_show_more_count=>7
,p_fc_filter_values=>false
,p_fc_sort_by_top_counts=>true
,p_fc_show_selected_first=>false
,p_fc_show_chart=>true
,p_fc_initial_chart=>false
,p_fc_actions_filter=>true
,p_fc_display_as=>'INLINE'
,p_fc_exclude_allowed=>true
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416026531912213964)
,p_name=>'P8_SEARCH'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416026017297213961)
,p_prompt=>'Search'
,p_source=>'FIRST_NAME,LAST_NAME,EMAIL,PHONE_NUMBER,JOB_ID,MANAGER_ID'
,p_source_type=>'FACET_COLUMN'
,p_display_as=>'NATIVE_SEARCH'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'input_field', 'FACET',
  'search_type', 'ROW')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3416025904706213961)
,p_name=>'Employees'
,p_static_id=>'search-results'
,p_template=>4075786578761660127
,p_display_sequence=>20
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--staticRowColors:t-Report--rowHighlight:t-Report--inline:t-Report--hideNoPagination'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_EMPLOYEES'
,p_include_rowid_column=>false
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>50
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_query_row_count_max=>100000
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416034022484213979)
,p_query_column_id=>9
,p_column_alias=>'COMMISSION_PCT'
,p_column_display_sequence=>9
,p_column_heading=>'Commission Percent'
,p_column_format=>'999990D00'
,p_column_alignment=>'RIGHT'
,p_heading_alignment=>'RIGHT'
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416034859690213981)
,p_query_column_id=>11
,p_column_alias=>'DEPARTMENT_ID'
,p_column_display_sequence=>11
,p_column_heading=>'Department'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_display_as=>'TEXT_FROM_LOV_ESC'
,p_named_lov=>wwv_flow_imp.id(3416027965267213966)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416032090634213975)
,p_query_column_id=>4
,p_column_alias=>'EMAIL'
,p_column_display_sequence=>4
,p_column_heading=>'Email'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416030841666213972)
,p_query_column_id=>1
,p_column_alias=>'EMPLOYEE_ID'
,p_column_display_sequence=>0
,p_column_heading=>'<span class="u-VisuallyHidden">Edit</span>'
,p_column_link=>'f?p=&APP_ID.:9:&APP_SESSION.::&DEBUG.:RP:P9_EMPLOYEE_ID:\#EMPLOYEE_ID#\'
,p_column_linktext=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_column_alignment=>'CENTER'
,p_report_column_required_role=>wwv_flow_imp.id(3415221674985210839)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416031250114213973)
,p_query_column_id=>2
,p_column_alias=>'FIRST_NAME'
,p_column_display_sequence=>2
,p_column_heading=>'First Name'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416032869707213977)
,p_query_column_id=>6
,p_column_alias=>'HIRE_DATE'
,p_column_display_sequence=>6
,p_column_heading=>'Hire Date'
,p_heading_alignment=>'LEFT'
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416033287586213978)
,p_query_column_id=>7
,p_column_alias=>'JOB_ID'
,p_column_display_sequence=>7
,p_column_heading=>'Job'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_display_as=>'TEXT_FROM_LOV_ESC'
,p_named_lov=>wwv_flow_imp.id(3416026846248213964)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416031699023213974)
,p_query_column_id=>3
,p_column_alias=>'LAST_NAME'
,p_column_display_sequence=>3
,p_column_heading=>'Last Name'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416034465002213980)
,p_query_column_id=>10
,p_column_alias=>'MANAGER_ID'
,p_column_display_sequence=>10
,p_column_heading=>'Manager'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_display_as=>'TEXT_FROM_LOV_ESC'
,p_named_lov=>wwv_flow_imp.id(3415251217724210934)
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416032413601213976)
,p_query_column_id=>5
,p_column_alias=>'PHONE_NUMBER'
,p_column_display_sequence=>5
,p_column_heading=>'Phone Number'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416033620378213979)
,p_query_column_id=>8
,p_column_alias=>'SALARY'
,p_column_display_sequence=>8
,p_column_heading=>'Salary'
,p_column_format=>'999G999G999G999G999G999G999G999G999G990'
,p_column_alignment=>'RIGHT'
,p_heading_alignment=>'RIGHT'
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416035212679213982)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416025904706213961)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:9:&APP_SESSION.::&DEBUG.:9::'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416029844826213970)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416029455349213969)
,p_button_name=>'RESET'
,p_static_id=>'reset'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI:t-Button--iconLeft'
,p_button_template_id=>2086257187394300437
,p_button_image_alt=>'Reset'
,p_button_position=>'NEXT'
,p_button_redirect_url=>'f?p=&APP_ID.:8:&APP_SESSION.::&DEBUG.:RR,8::'
,p_icon_css_classes=>'fa-undo'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416035612225213982)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416025904706213961)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416036073759213983)
,p_event_id=>wwv_flow_imp.id(3416035612225213982)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416025904706213961)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071338Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00009
begin
wwv_flow_imp_page.create_page(
 p_id=>9
,p_name=>'Employee'
,p_alias=>'EMPLOYEE'
,p_page_mode=>'MODAL'
,p_step_title=>'Employee'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>1664614232864994871
,p_page_template_options=>'#DEFAULT#:js-dialog-class-t-Drawer--pullOutEnd'
,p_required_role=>wwv_flow_imp.id(3415221674985210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416046482991214119)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416037700581213985)
,p_plug_name=>'Employee'
,p_static_id=>'employee'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_EMPLOYEES'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071338Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416046854636214119)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416046482991214119)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416047360941214120)
,p_button_id=>wwv_flow_imp.id(3416046854636214119)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416048675216214121)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416046482991214119)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P9_EMPLOYEE_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416047805292214120)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416046482991214119)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P9_EMPLOYEE_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416048266319214120)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416046482991214119)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P9_EMPLOYEE_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416041910741214115)
,p_name=>'P9_COMMISSION_PCT'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>90
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Commission Percent'
,p_source=>'COMMISSION_PCT'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416042774507214116)
,p_name=>'P9_DEPARTMENT_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>110
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Department'
,p_source=>'DEPARTMENT_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_DEPARTMENTS.DEPARTMENT_NAME'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416039971889214113)
,p_name=>'P9_EMAIL'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Email'
,p_source=>'EMAIL'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>25
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416038190375213986)
,p_name=>'P9_EMPLOYEE_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Employee ID'
,p_source=>'EMPLOYEE_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416039174734214112)
,p_name=>'P9_FIRST_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'First Name'
,p_source=>'FIRST_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>20
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416040753417214113)
,p_name=>'P9_HIRE_DATE'
,p_source_data_type=>'DATE'
,p_is_required=>true
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Hire Date'
,p_source=>'HIRE_DATE'
,p_display_as=>'NATIVE_DATE_PICKER_APEX'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'display_as', 'POPUP',
  'max_date', 'NONE',
  'min_date', 'NONE',
  'multiple_months', 'N',
  'show_time', 'N',
  'use_defaults', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416041153710214114)
,p_name=>'P9_JOB_ID'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>70
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Job'
,p_source=>'JOB_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_JOBS.JOB_TITLE'
,p_lov_display_null=>'YES'
,p_cHeight=>1
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416039558964214112)
,p_name=>'P9_LAST_NAME'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Last Name'
,p_source=>'LAST_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>25
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416042377766214115)
,p_name=>'P9_MANAGER_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>100
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Manager'
,p_source=>'MANAGER_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416040358449214113)
,p_name=>'P9_PHONE_NUMBER'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Phone Number'
,p_source=>'PHONE_NUMBER'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>20
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416041500714214114)
,p_name=>'P9_SALARY'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>80
,p_item_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_item_source_plug_id=>wwv_flow_imp.id(3416037700581213985)
,p_prompt=>'Salary'
,p_source=>'SALARY'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416049827835214122)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416049827835214122
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416049038471214121)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416037700581213985)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Employee'
,p_static_id=>'initialize-form-employee'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416049038471214121
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416049445820214121)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416037700581213985)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Employee'
,p_static_id=>'process-form-employee'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416049445820214121
,p_created_on=>wwv_flow_imp.dz('20261014071339Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071339Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00010
begin
wwv_flow_imp_page.create_page(
 p_id=>10
,p_name=>'Regions'
,p_alias=>'REGIONS'
,p_page_mode=>'MODAL'
,p_step_title=>'Regions'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416060772756214596)
,p_plug_name=>'Regions'
,p_static_id=>'regions'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_REGIONS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416060889841214596)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:11:&APP_SESSION.::&DEBUG.:RP:P11_REGION_ID:\#REGION_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416060889841214596
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416062104182214600)
,p_db_column_name=>'REGION_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Region ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416062553975214603)
,p_db_column_name=>'REGION_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Region Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416725447146217107)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'REGION_NAME'
,p_sort_column_1=>'REGION_NAME'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416062963519214604)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416060772756214596)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:11:&APP_SESSION.::&DEBUG.:11::'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416063352967214604)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416060772756214596)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416063719191214605)
,p_event_id=>wwv_flow_imp.id(3416063352967214604)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416060772756214596)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00011
begin
wwv_flow_imp_page.create_page(
 p_id=>11
,p_name=>'Region'
,p_alias=>'REGION'
,p_page_mode=>'MODAL'
,p_step_title=>'Region'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071343Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416056637484214591)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416054613650214478)
,p_plug_name=>'Region'
,p_static_id=>'region'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_REGIONS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071343Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416057003160214592)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416056637484214591)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416057502294214592)
,p_button_id=>wwv_flow_imp.id(3416057003160214592)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416058869462214594)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416056637484214591)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P11_REGION_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416058018719214593)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416056637484214591)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P11_REGION_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416058476216214593)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416056637484214591)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P11_REGION_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416055037573214479)
,p_name=>'P11_REGION_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416054613650214478)
,p_item_source_plug_id=>wwv_flow_imp.id(3416054613650214478)
,p_prompt=>'Region ID'
,p_source=>'REGION_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416055686051214590)
,p_name=>'P11_REGION_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416054613650214478)
,p_item_source_plug_id=>wwv_flow_imp.id(3416054613650214478)
,p_prompt=>'Region Name'
,p_source=>'REGION_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>25
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416060070735214595)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416060070735214595
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416059236423214594)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416054613650214478)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Region'
,p_static_id=>'initialize-form-region'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416059236423214594
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416059692536214594)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416054613650214478)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Region'
,p_static_id=>'process-form-region'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416059692536214594
,p_created_on=>wwv_flow_imp.dz('20261014071344Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071344Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00012
begin
wwv_flow_imp_page.create_page(
 p_id=>12
,p_name=>'Countries'
,p_alias=>'COUNTRIES'
,p_page_mode=>'MODAL'
,p_step_title=>'Countries'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416077034092215088)
,p_plug_name=>'Countries'
,p_static_id=>'countries'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_COUNTRIES'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416077140402215088)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:13:&APP_SESSION.::&DEBUG.:RP:P13_COUNTRY_ID:\#COUNTRY_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416077140402215088
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416078438881215092)
,p_db_column_name=>'COUNTRY_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Country ID'
,p_column_type=>'STRING'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416078844153215094)
,p_db_column_name=>'COUNTRY_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Country Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416079276288215095)
,p_db_column_name=>'REGION_ID'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Region'
,p_column_type=>'STRING'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_rpt_named_lov=>wwv_flow_imp.id(3416071442247215081)
,p_rpt_show_filter_lov=>'1'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416730057038217112)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'COUNTRY_ID:COUNTRY_NAME:REGION_ID:'
,p_sort_column_1=>'COUNTRY_ID'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416079686714215096)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416077034092215088)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:13:&APP_SESSION.::&DEBUG.:13::'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416080039711215097)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416077034092215088)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416080471224215097)
,p_event_id=>wwv_flow_imp.id(3416080039711215097)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416077034092215088)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00013
begin
wwv_flow_imp_page.create_page(
 p_id=>13
,p_name=>'Country'
,p_alias=>'COUNTRY'
,p_page_mode=>'MODAL'
,p_step_title=>'Country'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071348Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416072960140215084)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416069754724214957)
,p_plug_name=>'Country'
,p_static_id=>'country'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_COUNTRIES'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071348Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416073355574215084)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416072960140215084)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416073816918215085)
,p_button_id=>wwv_flow_imp.id(3416073355574215084)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416075104476215086)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416072960140215084)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P13_COUNTRY_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416074340435215085)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416072960140215084)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P13_COUNTRY_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416074718669215085)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416072960140215084)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P13_COUNTRY_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416070167530214958)
,p_name=>'P13_COUNTRY_ID'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_is_primary_key=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_item_source_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_prompt=>'Country ID'
,p_source=>'COUNTRY_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416070943925215081)
,p_name=>'P13_COUNTRY_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_item_source_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_prompt=>'Country Name'
,p_source=>'COUNTRY_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>40
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416071334724215081)
,p_name=>'P13_REGION_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_item_source_plug_id=>wwv_flow_imp.id(3416069754724214957)
,p_prompt=>'Region'
,p_source=>'REGION_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_REGIONS.REGION_NAME'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416076353982215087)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416076353982215087
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416075546847215086)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416069754724214957)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Country'
,p_static_id=>'initialize-form-country'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416075546847215086
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416075911818215086)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416069754724214957)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Country'
,p_static_id=>'process-form-country'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416075911818215086
,p_created_on=>wwv_flow_imp.dz('20261014071349Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071349Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00014
begin
wwv_flow_imp_page.create_page(
 p_id=>14
,p_name=>'Warehouses'
,p_alias=>'WAREHOUSES'
,p_page_mode=>'MODAL'
,p_step_title=>'Warehouses'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416090019091215577)
,p_plug_name=>'Warehouses'
,p_static_id=>'warehouses'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_WAREHOUSES'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416090122058215577)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:15:&APP_SESSION.::&DEBUG.:RP:P15_WAREHOUSE_ID:\#WAREHOUSE_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416090122058215577
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416092221724215584)
,p_db_column_name=>'LOCATION_ID'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Location'
,p_column_type=>'STRING'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_rpt_named_lov=>wwv_flow_imp.id(3416084403068215570)
,p_rpt_show_filter_lov=>'1'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416091467183215581)
,p_db_column_name=>'WAREHOUSE_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Warehouse ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416091864779215583)
,p_db_column_name=>'WAREHOUSE_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Warehouse Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416735301822217118)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'WAREHOUSE_NAME:LOCATION_ID'
,p_sort_column_1=>'WAREHOUSE_NAME'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416092693377215585)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416090019091215577)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:15:&APP_SESSION.::&DEBUG.:15::'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416093075928215585)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416090019091215577)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416093430423215586)
,p_event_id=>wwv_flow_imp.id(3416093075928215585)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416090019091215577)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00015
begin
wwv_flow_imp_page.create_page(
 p_id=>15
,p_name=>'Warehouse'
,p_alias=>'WAREHOUSE'
,p_page_mode=>'MODAL'
,p_step_title=>'Warehouse'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071352Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416085980626215572)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416083116663215455)
,p_plug_name=>'Warehouse'
,p_static_id=>'warehouse'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_WAREHOUSES'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071353Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416086329531215573)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416085980626215572)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416086874265215573)
,p_button_id=>wwv_flow_imp.id(3416086329531215573)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416088191097215575)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416085980626215572)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P15_WAREHOUSE_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416087349070215574)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416085980626215572)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P15_WAREHOUSE_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416087750755215574)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416085980626215572)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P15_WAREHOUSE_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416084338203215570)
,p_name=>'P15_LOCATION_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_prompt=>'Location'
,p_source=>'LOCATION_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_LOCATIONS.STREET_ADDRESS'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416083479338215457)
,p_name=>'P15_WAREHOUSE_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_prompt=>'Warehouse ID'
,p_source=>'WAREHOUSE_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416083917804215570)
,p_name=>'P15_WAREHOUSE_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416083116663215455)
,p_prompt=>'Warehouse Name'
,p_source=>'WAREHOUSE_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>35
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416089375308215576)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416089375308215576
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416088542730215575)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416083116663215455)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Warehouse'
,p_static_id=>'initialize-form-warehouse'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416088542730215575
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416088947903215575)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416083116663215455)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Warehouse'
,p_static_id=>'process-form-warehouse'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416088947903215575
,p_created_on=>wwv_flow_imp.dz('20261014071354Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071354Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00016
begin
wwv_flow_imp_page.create_page(
 p_id=>16
,p_name=>'Products'
,p_alias=>'PRODUCTS'
,p_page_mode=>'MODAL'
,p_step_title=>'Products'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416626545802216084)
,p_plug_name=>'Product Information'
,p_static_id=>'products'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_PRODUCT_INFORMATION'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416626627567216084)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:17:&APP_SESSION.::&DEBUG.:RP:P17_PRODUCT_ID:\#PRODUCT_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416626627567216084
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416632269139216103)
,p_db_column_name=>'CATALOG_URL'
,p_display_order=>11
,p_column_identifier=>'K'
,p_column_label=>'Catalog URL'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416629213605216094)
,p_db_column_name=>'CATEGORY_ID'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Category ID'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416631455392216100)
,p_db_column_name=>'LIST_PRICE'
,p_display_order=>9
,p_column_identifier=>'I'
,p_column_label=>'List Price'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416631868775216102)
,p_db_column_name=>'MIN_PRICE'
,p_display_order=>10
,p_column_identifier=>'J'
,p_column_label=>'Min Price'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416628754601216092)
,p_db_column_name=>'PRODUCT_DESCRIPTION'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Product Description'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416627974815216089)
,p_db_column_name=>'PRODUCT_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Product ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416628323402216091)
,p_db_column_name=>'PRODUCT_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Product Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416631091427216099)
,p_db_column_name=>'PRODUCT_STATUS'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Product Status'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416630609882216098)
,p_db_column_name=>'SUPPLIER_ID'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Supplier ID'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416630230249216096)
,p_db_column_name=>'WARRANTY_PERIOD'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Warranty Period'
,p_allow_sorting=>'N'
,p_allow_filtering=>'N'
,p_allow_highlighting=>'N'
,p_allow_ctrl_breaks=>'N'
,p_allow_aggregations=>'N'
,p_allow_computations=>'N'
,p_allow_charting=>'N'
,p_allow_group_by=>'N'
,p_allow_hide=>'N'
,p_column_type=>'OTHER'
,p_heading_alignment=>'LEFT'
,p_rpt_show_filter_lov=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416629794255216095)
,p_db_column_name=>'WEIGHT_CLASS'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Weight Class'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990D0'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416741221269217124)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'PRODUCT_NAME:PRODUCT_DESCRIPTION:WEIGHT_CLASS:WARRANTY_PERIOD:PRODUCT_STATUS:LIST_PRICE:MIN_PRICE:CATALOG_URL'
,p_sort_column_1=>'PRODUCT_NAME'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416632655613216104)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416626545802216084)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:17:&APP_SESSION.::&DEBUG.:17::'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416633031745216105)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416626545802216084)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416633489427216105)
,p_event_id=>wwv_flow_imp.id(3416633031745216105)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416626545802216084)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00017
begin
wwv_flow_imp_page.create_page(
 p_id=>17
,p_name=>'Product Information'
,p_alias=>'PRODUCT-INFORMATION'
,p_page_mode=>'MODAL'
,p_step_title=>'Product Information'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071357Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416622445796216080)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416613847779215943)
,p_plug_name=>'Product Information'
,p_static_id=>'product-information'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_PRODUCT_INFORMATION'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071357Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416622858651216081)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416622445796216080)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416623381697216081)
,p_button_id=>wwv_flow_imp.id(3416622858651216081)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416624675250216082)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416622445796216080)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P17_PRODUCT_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416623817864216082)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416622445796216080)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P17_PRODUCT_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416624269709216082)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416622445796216080)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P17_PRODUCT_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416618749744216077)
,p_name=>'P17_CATALOG_URL'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>110
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Catalog URL'
,p_source=>'CATALOG_URL'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>50
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416615835125216073)
,p_name=>'P17_CATEGORY_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Category ID'
,p_source=>'CATEGORY_ID'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416617965802216076)
,p_name=>'P17_LIST_PRICE'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>90
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'List Price'
,p_source=>'LIST_PRICE'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416618333867216077)
,p_name=>'P17_MIN_PRICE'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>100
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Min Price'
,p_source=>'MIN_PRICE'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416615488302216073)
,p_name=>'P17_PRODUCT_DESCRIPTION'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Product Description'
,p_source=>'PRODUCT_DESCRIPTION'
,p_display_as=>'NATIVE_TEXTAREA'
,p_cSize=>60
,p_cMaxlength=>2000
,p_cHeight=>4
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'auto_height', 'N',
  'character_counter', 'N',
  'resizable', 'Y',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416614239783215945)
,p_name=>'P17_PRODUCT_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Product ID'
,p_source=>'PRODUCT_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416615066919216072)
,p_name=>'P17_PRODUCT_NAME'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Product Name'
,p_source=>'PRODUCT_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>50
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416617441077216075)
,p_name=>'P17_PRODUCT_STATUS'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>80
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Product Status'
,p_source=>'PRODUCT_STATUS'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>20
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416617038576216075)
,p_name=>'P17_SUPPLIER_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>70
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Supplier ID'
,p_source=>'SUPPLIER_ID'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416616652250216074)
,p_name=>'P17_WARRANTY_PERIOD'
,p_source_data_type=>'INTERVAL_Y2M'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Warranty Period'
,p_source=>'WARRANTY_PERIOD'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416616292693216074)
,p_name=>'P17_WEIGHT_CLASS'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_item_source_plug_id=>wwv_flow_imp.id(3416613847779215943)
,p_prompt=>'Weight Class'
,p_source=>'WEIGHT_CLASS'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416625886776216084)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416625886776216084
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416625033255216083)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416613847779215943)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Product Information'
,p_static_id=>'initialize-form-product-information'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416625033255216083
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416625404366216083)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416613847779215943)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Product Information'
,p_static_id=>'process-form-product-information'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416625404366216083
,p_created_on=>wwv_flow_imp.dz('20261014071359Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071359Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00018
begin
wwv_flow_imp_page.create_page(
 p_id=>18
,p_name=>'Jobs'
,p_alias=>'JOBS'
,p_page_mode=>'MODAL'
,p_step_title=>'Jobs'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416645263326216579)
,p_plug_name=>'Jobs'
,p_static_id=>'jobs'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_JOBS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416645302140216579)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:19:&APP_SESSION.::&DEBUG.:RP:P19_JOB_ID:\#JOB_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416645302140216579
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416646633860216583)
,p_db_column_name=>'JOB_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Job ID'
,p_column_type=>'STRING'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416647090214216585)
,p_db_column_name=>'JOB_TITLE'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Job Title'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416647837972216588)
,p_db_column_name=>'MAX_SALARY'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Max Salary'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416647401396216587)
,p_db_column_name=>'MIN_SALARY'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Min Salary'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416760554412217143)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'JOB_ID:JOB_TITLE:MIN_SALARY:MAX_SALARY:'
,p_sort_column_1=>'JOB_ID'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416648243548216589)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416645263326216579)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:19:&APP_SESSION.::&DEBUG.:19::'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416648680535216590)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416645263326216579)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416649083095216590)
,p_event_id=>wwv_flow_imp.id(3416648680535216590)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416645263326216579)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00019
begin
wwv_flow_imp_page.create_page(
 p_id=>19
,p_name=>'Job'
,p_alias=>'JOB'
,p_page_mode=>'MODAL'
,p_step_title=>'Job'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071402Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416641000890216574)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416637252478216455)
,p_plug_name=>'Job'
,p_static_id=>'job'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_JOBS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071403Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416641483724216574)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416641000890216574)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416641905168216575)
,p_button_id=>wwv_flow_imp.id(3416641483724216574)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416643249125216576)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416641000890216574)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P19_JOB_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416642479360216576)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416641000890216574)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P19_JOB_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416642859778216576)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416641000890216574)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P19_JOB_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416637534802216457)
,p_name=>'P19_JOB_ID'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_is_primary_key=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_prompt=>'Job ID'
,p_source=>'JOB_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416638666376216571)
,p_name=>'P19_JOB_TITLE'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_prompt=>'Job Title'
,p_source=>'JOB_TITLE'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>35
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416639492831216572)
,p_name=>'P19_MAX_SALARY'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_prompt=>'Max Salary'
,p_source=>'MAX_SALARY'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416639092053216572)
,p_name=>'P19_MIN_SALARY'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_item_source_plug_id=>wwv_flow_imp.id(3416637252478216455)
,p_prompt=>'Min Salary'
,p_source=>'MIN_SALARY'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_cSize=>32
,p_cMaxlength=>255
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_alignment', 'left',
  'virtual_keyboard', 'decimal')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416644466172216578)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416644466172216578
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416643625018216577)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416637252478216455)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Job'
,p_static_id=>'initialize-form-job'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416643625018216577
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416644053512216577)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416637252478216455)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Job'
,p_static_id=>'process-form-job'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416644053512216577
,p_created_on=>wwv_flow_imp.dz('20261014071404Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071404Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00020
begin
wwv_flow_imp_page.create_page(
 p_id=>20
,p_name=>'Departments'
,p_alias=>'DEPARTMENTS'
,p_page_mode=>'MODAL'
,p_step_title=>'Departments'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>To find data enter a search term into the search dialog, or click on the column headings to limit the records returned.</p>',
'',
'<p>You can perform numerous functions by clicking the <strong>Actions</strong> button. This includes selecting the columns that are displayed / hidden and their display sequence, plus numerous data and format functions.  You can also define additiona'
||'l views of the data using the chart, group by, and pivot options.</p>',
'',
'<p>If you want to save your customizations select report, or click download to unload the data. Enter you email address and time frame under subscription to be sent the data on a regular basis.</p>',
'',
'<p>For additional information click Help at the bottom of the Actions menu.</p> ',
'',
'<p>Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416688975620217065)
,p_plug_name=>'Departments'
,p_static_id=>'departments'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_DEPARTMENTS'
,p_include_rowid_column=>false
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416689000067217065)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:21:&APP_SESSION.::&DEBUG.:RP:P21_DEPARTMENT_ID:\#DEPARTMENT_ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416689000067217065
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416690735396217069)
,p_db_column_name=>'DEPARTMENT_ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'Department ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416691519305217071)
,p_db_column_name=>'DEPARTMENT_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Department Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416693408721217074)
,p_db_column_name=>'LOCATION_ID'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Location'
,p_column_type=>'STRING'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_rpt_named_lov=>wwv_flow_imp.id(3416084403068215570)
,p_rpt_show_filter_lov=>'1'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416693040685217073)
,p_db_column_name=>'MANAGER_ID'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Manager'
,p_column_type=>'STRING'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_rpt_named_lov=>wwv_flow_imp.id(3415251217724210934)
,p_rpt_show_filter_lov=>'1'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416768640064217152)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'DEPARTMENT_NAME:MANAGER_ID:LOCATION_ID'
,p_sort_column_1=>'DEPARTMENT_NAME'
,p_sort_direction_1=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416694166461217075)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416688975620217065)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:21:&APP_SESSION.::&DEBUG.:21::'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416694698825217076)
,p_name=>'Edit Report - Dialog Closed'
,p_static_id=>'edit-report-dialog-closed'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416688975620217065)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416695183612217076)
,p_event_id=>wwv_flow_imp.id(3416694698825217076)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416688975620217065)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_00021
begin
wwv_flow_imp_page.create_page(
 p_id=>21
,p_name=>'Department'
,p_alias=>'DEPARTMENT'
,p_page_mode=>'MODAL'
,p_step_title=>'Department'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071407Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416684819752217061)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416679486504216939)
,p_plug_name=>'Department'
,p_static_id=>'department'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'OEHR_DEPARTMENTS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071407Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416685232674217061)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416684819752217061)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416685720853217062)
,p_button_id=>wwv_flow_imp.id(3416685232674217061)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416687037836217063)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416684819752217061)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P21_DEPARTMENT_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416686285246217062)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416684819752217061)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P21_DEPARTMENT_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416686657416217063)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416684819752217061)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P21_DEPARTMENT_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416679982800216943)
,p_name=>'P21_DEPARTMENT_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_item_source_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_prompt=>'Department ID'
,p_source=>'DEPARTMENT_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416682462042217058)
,p_name=>'P21_DEPARTMENT_NAME'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_item_source_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_prompt=>'Department Name'
,p_source=>'DEPARTMENT_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>32
,p_cMaxlength=>30
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416683287296217059)
,p_name=>'P21_LOCATION_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_item_source_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_prompt=>'Location'
,p_source=>'LOCATION_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_LOCATIONS.STREET_ADDRESS'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416682854089217059)
,p_name=>'P21_MANAGER_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_item_source_plug_id=>wwv_flow_imp.id(3416679486504216939)
,p_prompt=>'Manager'
,p_source=>'MANAGER_ID'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'OEHR_EMPLOYEES.FIRST_NAME'
,p_lov_display_null=>'YES'
,p_label_alignment=>'RIGHT'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_lov_display_extra=>'YES'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416688284421217064)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
,p_internal_uid=>3416688284421217064
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416687441894217063)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(3416679486504216939)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Department'
,p_static_id=>'initialize-form-department'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'current_row_total_item', '',
  'next_primary_key_items', '',
  'previous_primary_key_items', '')).to_clob
,p_internal_uid=>3416687441894217063
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416687812749217064)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416679486504216939)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Department'
,p_static_id=>'process-form-department'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'Y',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'Y',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416687812749217064
,p_created_on=>wwv_flow_imp.dz('20261014071409Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071409Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_09999
begin
wwv_flow_imp_page.create_page(
 p_id=>9999
,p_name=>'Login Page'
,p_alias=>'LOGIN'
,p_step_title=>'Demonstration - HR - Log In'
,p_warn_on_unsaved_changes=>'N'
,p_first_item=>'AUTO_FIRST_ITEM'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>2104585595298951431
,p_page_template_options=>'#DEFAULT#'
,p_page_is_public_y_n=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'12'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3415231393911210855)
,p_plug_name=>'Demonstration - HR'
,p_static_id=>'demonstration-hr'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2677585639786677191
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_region_image=>'#APP_FILES#icons/app-icon-512.png'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3415233432543210891)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3415231393911210855)
,p_button_name=>'LOGIN'
,p_static_id=>'login'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Sign In'
,p_button_position=>'NEXT'
,p_grid_new_row=>'Y'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415232309293210889)
,p_name=>'P9999_PASSWORD'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3415231393911210855)
,p_prompt=>'Password'
,p_placeholder=>'Password'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_PASSWORD'
,p_cSize=>40
,p_cMaxlength=>100
,p_tag_attributes=>'autocomplete="current-password"'
,p_label_alignment=>'RIGHT'
,p_field_template=>2044213549383960320
,p_item_icon_css_classes=>'fa-key'
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'submit_when_enter_pressed', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415233174005210891)
,p_name=>'P9999_PERSISTENT_AUTH'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3415231393911210855)
,p_prompt=>'Remember me'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_SINGLE_CHECKBOX'
,p_label_alignment=>'RIGHT'
,p_display_when=>'apex_authentication.persistent_auth_enabled'
,p_display_when2=>'PLSQL'
,p_display_when_type=>'EXPRESSION'
,p_field_template=>2044213549383960320
,p_item_template_options=>'#DEFAULT#'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'use_defaults', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415232799520210890)
,p_name=>'P9999_REMEMBER'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3415231393911210855)
,p_prompt=>'Remember username'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_SINGLE_CHECKBOX'
,p_label_alignment=>'RIGHT'
,p_display_when=>'apex_authentication.persistent_cookies_enabled and not apex_authentication.persistent_auth_enabled'
,p_display_when2=>'PLSQL'
,p_display_when_type=>'EXPRESSION'
,p_field_template=>2044213549383960320
,p_item_template_options=>'#DEFAULT#'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'use_defaults', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3415231982681210889)
,p_name=>'P9999_USERNAME'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3415231393911210855)
,p_prompt=>'Username'
,p_placeholder=>'Username'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>40
,p_cMaxlength=>100
,p_tag_attributes=>'autocomplete="username"'
,p_label_alignment=>'RIGHT'
,p_field_template=>2044213549383960320
,p_item_icon_css_classes=>'fa-user'
,p_item_template_options=>'#DEFAULT#'
,p_is_persistent=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415237599004210895)
,p_process_sequence=>30
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_SESSION_STATE'
,p_process_name=>'Clear Page(s) Cache'
,p_static_id=>'clear-page-s-cache'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'type', 'CLEAR_CACHE_CURRENT_PAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3415237599004210895
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415237110128210895)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Get Username Cookie'
,p_static_id=>'get-username-cookie'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
':P9999_USERNAME := apex_authentication.get_login_username_cookie;',
':P9999_REMEMBER := case when :P9999_USERNAME is not null then ''Y'' end;'))
,p_process_clob_language=>'PLSQL'
,p_internal_uid=>3415237110128210895
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415233897432210892)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Login'
,p_static_id=>'login'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'package', 'APEX_AUTHENTICATION',
  'package_method', 'LOGIN',
  'type', 'PLSQL_PACKAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3415233897432210892
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3415234849983210893)
,p_page_process_id=>wwv_flow_imp.id(3415233897432210892)
,p_page_id=>9999
,p_name=>'p_password'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>false
,p_display_sequence=>2
,p_value_type=>'ITEM'
,p_value=>'P9999_PASSWORD'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3415235384034210893)
,p_page_process_id=>wwv_flow_imp.id(3415233897432210892)
,p_page_id=>9999
,p_name=>'p_set_persistent_auth'
,p_direction=>'IN'
,p_data_type=>'BOOLEAN'
,p_has_default=>true
,p_display_sequence=>3
,p_value_type=>'ITEM'
,p_value=>'P9999_PERSISTENT_AUTH'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3415234389725210892)
,p_page_process_id=>wwv_flow_imp.id(3415233897432210892)
,p_page_id=>9999
,p_name=>'p_username'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>false
,p_display_sequence=>1
,p_value_type=>'ITEM'
,p_value=>'P9999_USERNAME'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3415235791443210894)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Set Username Cookie'
,p_static_id=>'set-username-cookie'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'package', 'APEX_AUTHENTICATION',
  'package_method', 'SEND_LOGIN_USERNAME_COOKIE',
  'type', 'PLSQL_PACKAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3415235791443210894
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3415236784327210894)
,p_page_process_id=>wwv_flow_imp.id(3415235791443210894)
,p_page_id=>9999
,p_name=>'p_consent'
,p_direction=>'IN'
,p_data_type=>'BOOLEAN'
,p_has_default=>false
,p_display_sequence=>2
,p_value_type=>'ITEM'
,p_value=>'P9999_REMEMBER'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3415236278047210894)
,p_page_process_id=>wwv_flow_imp.id(3415235791443210894)
,p_page_id=>9999
,p_name=>'p_username'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>false
,p_display_sequence=>1
,p_value_type=>'EXPRESSION'
,p_value_language=>'PLSQL'
,p_value=>'lower( :P9999_USERNAME )'
,p_created_on=>wwv_flow_imp.dz('20261014071307Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071307Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10000
begin
wwv_flow_imp_page.create_page(
 p_id=>10000
,p_name=>'Administration'
,p_alias=>'ADMINISTRATION'
,p_step_title=>'Administration'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_protection_level=>'C'
,p_deep_linking=>'N'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>The administration page allows application owners (Administrators) to configure the application and maintain common data used across the application.',
'By selecting one of the available settings, administrators can potentially change how the application is displayed and/or features available to the end users.</p>',
'<p>Access to this page should be limited to Administrators only.</p>'))
,p_page_component_map=>'25'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417086005828217520)
,p_plug_name=>'Access Control'
,p_static_id=>'access-control'
,p_parent_plug_id=>wwv_flow_imp.id(3417085562044217519)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>70
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417093057668217530)
,p_plug_name=>'Access Control Actions'
,p_static_id=>'access-control-actions'
,p_parent_plug_id=>wwv_flow_imp.id(3417086005828217520)
,p_region_template_options=>'#DEFAULT#'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417075510938217510)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417087011248217520)
,p_plug_name=>'ACL Information'
,p_static_id=>'acl-information'
,p_parent_plug_id=>wwv_flow_imp.id(3417086005828217520)
,p_region_css_classes=>'margin-sm'
,p_region_template_options=>'#DEFAULT#:t-Alert--colorBG:t-Alert--horizontal:t-Alert--noIcon:t-Alert--warning:t-Alert--accessibleHeading'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2044111091335791563
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_function_body_language=>'PLSQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'declare',
'    l_acl_scope varchar2(45);',
'begin',
'    l_acl_scope := apex_app_setting.get_value( p_name => ''ACCESS_CONTROL_SCOPE'' );',
'',
'    if l_acl_scope = ''ALL_USERS'' then',
'        return apex_lang.message(''APEX.FEATURE.ACL.INFO.ALL_USERS'');',
'    elsif l_acl_scope = ''ACL_ONLY'' then',
'        return apex_lang.message(''APEX.FEATURE.ACL.INFO.ACL_ONLY'');',
'    else',
'        return apex_lang.message(''APEX.FEATURE.ACL.INFO.ACL_VALUE_INVALID'', l_acl_scope);',
'    end if;',
'end;'))
,p_plug_source_type=>'NATIVE_DYNAMIC_CONTENT'
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417084972697217519)
,p_plug_name=>'Activity Reports'
,p_static_id=>'activity-reports'
,p_parent_plug_id=>wwv_flow_imp.id(3417082889649217517)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>60
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417071137395217505)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417083459594217517)
,p_plug_name=>'Application Administration'
,p_static_id=>'application-administration'
,p_parent_plug_id=>wwv_flow_imp.id(3417082889649217517)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417078436266217513)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417067851056217502)
,p_plug_name=>'Breadcrumb'
,p_static_id=>'breadcrumb'
,p_region_template_options=>'#DEFAULT#:t-BreadcrumbRegion--useBreadcrumbTitle'
,p_component_template_options=>'#DEFAULT#'
,p_plug_template=>2534890969069732905
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_menu_id=>wwv_flow_imp.id(3415214906381210815)
,p_plug_source_type=>'NATIVE_BREADCRUMB'
,p_menu_template_id=>4075790987805660140
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417082889649217517)
,p_plug_name=>'Column 1'
,p_static_id=>'column-1'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>3374665444246510938
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417085562044217519)
,p_plug_name=>'Column 2'
,p_static_id=>'column-2'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>3374665444246510938
,p_plug_display_sequence=>20
,p_plug_new_grid_row=>false
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417083930010217518)
,p_plug_name=>'Configuration'
,p_static_id=>'configuration'
,p_parent_plug_id=>wwv_flow_imp.id(3417082889649217517)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>40
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417068846300217503)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_required_patch=>wwv_flow_imp.id(3415219141650210834)
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417093540359217530)
,p_plug_name=>'Feedback'
,p_static_id=>'feedback'
,p_parent_plug_id=>wwv_flow_imp.id(3417085562044217519)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>80
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417097125762217536)
,p_plug_name=>'Feedback'
,p_static_id=>'feedback-2'
,p_parent_plug_id=>wwv_flow_imp.id(3417093540359217530)
,p_region_template_options=>'#DEFAULT#'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417077221528217511)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3417094020842217531)
,p_name=>'Report'
,p_static_id=>'report'
,p_parent_plug_id=>wwv_flow_imp.id(3417093540359217530)
,p_template=>4075786578761660127
,p_display_sequence=>10
,p_region_template_options=>'#DEFAULT#:t-Region--removeHeader js-removeLandmark:t-Region--stacked:t-Region--scrollBody:t-Region--noPadding'
,p_component_template_options=>'#DEFAULT#:t-AVPList--rightAligned'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select l.display_value                              as feedback_status, ',
'       (select count(*)',
'          from apex_team_feedback f',
'         where f.application_id  = :APP_ID',
'           and f.feedback_status = l.return_value ) as feedback_count ',
'  from apex_application_lov_entries l',
' where l.application_id      = :APP_ID',
'   and l.list_of_values_name = ''FEEDBACK_STATUS''',
' order by 2 desc, 1'))
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2103942766914282568
,p_query_num_rows=>15
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3417096114251217534)
,p_query_column_id=>2
,p_column_alias=>'FEEDBACK_COUNT'
,p_column_display_sequence=>2
,p_column_heading=>'Feedback Count'
,p_column_format=>'999G999G999G999G999G999G990'
,p_column_alignment=>'RIGHT'
,p_heading_alignment=>'RIGHT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3417095548126217533)
,p_query_column_id=>1
,p_column_alias=>'FEEDBACK_STATUS'
,p_column_display_sequence=>1
,p_column_heading=>'Feedback Status'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3417087585848217521)
,p_name=>'User Counts Report'
,p_static_id=>'user-counts-report'
,p_parent_plug_id=>wwv_flow_imp.id(3417086005828217520)
,p_template=>4075786578761660127
,p_display_sequence=>20
,p_region_template_options=>'#DEFAULT#:t-Region--removeHeader js-removeLandmark:t-Region--stacked:t-Region--scrollBody:t-Region--noPadding'
,p_component_template_options=>'#DEFAULT#:t-AVPList--rightAligned'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select r.role_name,',
'       (select count(*)',
'          from apex_appl_acl_user_roles ur',
'         where r.role_id = ur.role_id) user_count,',
'       r.role_id',
'  from apex_appl_acl_roles r',
' where r.application_id = :APP_ID',
' group by r.role_name, r.role_id',
' order by 2 desc, 1'))
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2103942766914282568
,p_query_num_rows=>15
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3417090847516217528)
,p_query_column_id=>3
,p_column_alias=>'ROLE_ID'
,p_column_display_sequence=>3
,p_column_heading=>'Role Id'
,p_column_alignment=>'RIGHT'
,p_heading_alignment=>'RIGHT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3417089519632217526)
,p_query_column_id=>1
,p_column_alias=>'ROLE_NAME'
,p_column_display_sequence=>1
,p_column_heading=>'Role Name'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3417090246759217527)
,p_query_column_id=>2
,p_column_alias=>'USER_COUNT'
,p_column_display_sequence=>2
,p_column_heading=>'User Count'
,p_column_format=>'999G999G999G999G999G999G990'
,p_column_alignment=>'RIGHT'
,p_heading_alignment=>'RIGHT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417084450990217518)
,p_plug_name=>'User Interface'
,p_static_id=>'user-interface'
,p_parent_plug_id=>wwv_flow_imp.id(3417082889649217517)
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:u-colors'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>50
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417070088960217504)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_plug_query_num_rows=>15
,p_required_patch=>wwv_flow_imp.id(3415219520831210834)
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417086538810217520)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3417086005828217520)
,p_button_name=>'ADD_USER'
,p_static_id=>'add-user'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI:t-Button--iconLeft'
,p_button_template_id=>2086257187394300437
,p_button_image_alt=>'Add User'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:10042:&APP_SESSION.::&DEBUG.:RP,10042::'
,p_icon_css_classes=>'fa-user-plus'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3417091849180217529)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'BUTTON'
,p_triggering_button_id=>wwv_flow_imp.id(3417086538810217520)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3417092361798217529)
,p_event_id=>wwv_flow_imp.id(3417091849180217529)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3417087585848217521)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10010
begin
wwv_flow_imp_page.create_page(
 p_id=>10010
,p_name=>'Configuration Options'
,p_alias=>'CONFIGURATION-OPTIONS'
,p_page_mode=>'MODAL'
,p_step_title=>'Configuration Options'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415219141650210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Configuration settings allow you to make specific functionality either available (enabled) or unavailable (disabled) to end users.</p>',
'<p>If a specific function is not 100% ready, or needs to be temporarily removed, click <strong>Disabled</strong>. ',
'Once it should be made available, simply click <strong>Enabled</strong>.</p>',
'<p><em><strong>Note:</strong> Changes made here will not be reflected for individual end users currently running the application. Once the end user signs out and then signs back in the revised feature settings will be invoked.</em></p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416796253186217175)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416796494188217175)
,p_plug_name=>'Configuration Options'
,p_static_id=>'configuration-options'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select ',
'    build_option_id     ID, ',
'    build_option_name   application_option,',
'    apex_item.hidden(1, build_option_id) ||',
'    apex_item.hidden(2, build_option_status) ||',
'    apex_item.switch ( ',
'         p_idx        => 3,',
'         p_value      => build_option_status,',
'         p_on_value   => ''Include'',',
'         p_on_label   => m.enabled,',
'         p_off_value  => ''Exclude'',',
'         p_off_label  => m.disabled,',
'         p_item_id    => ''BO_OPT_'' || rownum,',
'         p_item_label => ( case when build_option_status = ''Include'' then',
'                               apex_lang.message( ''APEX.FEATURE.CONFIG.IS_ENABLED'', apex_escape.html(build_option_name) )',
'                           when build_option_status = ''Exclude'' then',
'                               apex_lang.message( ''APEX.FEATURE.CONFIG.IS_DISABLED'', apex_escape.html(build_option_name) )',
'                           end )) "STATUS",',
'    component_comment   description,',
'    last_updated_on        updated,',
'    lower(last_updated_by) updated_by,',
'    build_option_status current_status',
'  from apex_application_build_options,',
'  (select apex_lang.message(''APEX.FEATURE.CONFIG.ENABLED'') enabled, apex_lang.message(''APEX.FEATURE.CONFIG.DISABLED'') disabled from sys.dual) m',
' where application_id = :APP_ID ',
' and (feature_identifier not in ( ''APPLICATION_ACCESS_CONTROL'',''APPLICATION_CONFIGURATION'') or feature_identifier is null)'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416797167930217175)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416797167930217175
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416801053133217183)
,p_db_column_name=>'APPLICATION_OPTION'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Feature'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416804831144217190)
,p_db_column_name=>'CURRENT_STATUS'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Current Status'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416802503293217186)
,p_db_column_name=>'DESCRIPTION'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Description'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416800095293217181)
,p_db_column_name=>'ID'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416801826780217185)
,p_db_column_name=>'STATUS'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Status'
,p_allow_filtering=>'N'
,p_column_type=>'STRING'
,p_display_text_as=>'WITHOUT_MODIFICATION'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416803365956217187)
,p_db_column_name=>'UPDATED'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Updated'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'SINCE'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416804086251217189)
,p_db_column_name=>'UPDATED_BY'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Updated By'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416808838424217194)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'APPLICATION_OPTION:STATUS:DESCRIPTION:UPDATED:UPDATED_BY'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416810150845217195)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416796253186217175)
,p_button_name=>'APPLY_CHANGES'
,p_static_id=>'apply-changes'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(3416811580401217197)
,p_branch_name=>'Branch to Admin Page'
,p_branch_action=>'f?p=&APP_ID.:10000:&APP_SESSION.::&DEBUG.:::&success_msg=#SUCCESS_MSG#'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>10
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416810816854217196)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Update'
,p_static_id=>'update'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'for i in 1..apex_application.g_f01.count loop',
'    for c1 in ( select application_id, build_option_name, build_option_status',
'                from apex_application_build_options',
'                where apex_application.g_f01(i) = build_option_id',
'                   and application_Id = :APP_ID) loop',
'        if c1.build_option_status != apex_application.g_f03(i) then',
'            apex_util.set_build_option_status(  p_application_id => :APP_ID,',
'                                                p_id => apex_application.g_f01(i),',
'                                                p_build_status => upper(apex_application.g_f03(i)) );',
'        end if;',
'    end loop;',
'end loop;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_success_message=>'Configuration Options updated. '
,p_internal_uid=>3416810816854217196
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10020
begin
wwv_flow_imp_page.create_page(
 p_id=>10020
,p_name=>'Application Appearance'
,p_alias=>'APPLICATION-APPEARANCE'
,p_page_mode=>'MODAL'
,p_step_title=>'Application Appearance'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415219520831210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Select the default color scheme used to display the application.</p>',
'<p>If <strong>Allow all End Users to choose Theme Style</strong> is checked, then each end user can select from the available theme styles by clicking the <em>Customize</em> link in the bottom left corner of the Home page.</p>'))
,p_page_component_map=>'16'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416812780475217200)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416812824915217200)
,p_plug_name=>'Configure Appearance'
,p_static_id=>'configure-appearance'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'BELOW'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416814410716217202)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416812780475217200)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416815028717217203)
,p_button_id=>wwv_flow_imp.id(3416814410716217202)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416815693819217203)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416812780475217200)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(3416816238184217204)
,p_branch_name=>'Branch to Admin Page'
,p_branch_action=>'f?p=&APP_ID.:10000:&APP_SESSION.::&DEBUG.:RP::&success_msg=#SUCCESS_MSG#'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>10
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416816699890217204)
,p_name=>'P10020_DESKTOP_THEME_STYLE_ID'
,p_is_required=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416812824915217200)
,p_use_cache_before_default=>'NO'
,p_prompt=>'Theme Style'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select s.theme_style_id',
'from apex_application_theme_styles s,',
'    apex_application_themes t',
'where s.application_id = t.application_id',
'    and s.theme_number = t.theme_number',
'    and s.application_id = :app_id',
'    and s.is_current = ''Yes'''))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'DESKTOP THEME STYLES'
,p_cHeight=>1
,p_grid_label_column_span=>3
,p_display_when=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select null',
'  from apex_application_theme_styles s,',
'       apex_application_themes t',
' where s.application_id = t.application_id',
'   and s.theme_number   = t.theme_number',
'   and s.application_id = :app_id'))
,p_display_when_type=>'EXISTS'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_restricted_characters=>'WEB_SAFE'
,p_inline_help_text=>'The default Theme Style applies to all users.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416818576477217207)
,p_name=>'P10020_END_USER_STYLE'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416812824915217200)
,p_use_cache_before_default=>'NO'
,p_prompt=>'End User Theme Preference'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select a.theme_style_by_user_pref',
'  from apex_applications a',
' where a.application_id  = :app_id'))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'USER_THEME_PREFERENCE'
,p_grid_label_column_span=>0
,p_field_template=>2044213549383960320
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_inline_help_text=>'If checked, end users may choose their own Theme Style using the Customize link.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_of_columns', '1')).to_clob
,p_multi_value_type=>'SEPARATED'
,p_multi_value_separator=>':'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416820596037217209)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Save End User Style Preference'
,p_static_id=>'save-end-user-style-preference'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'declare',
'    l_enabled boolean := case when :P10020_END_USER_STYLE = ''Yes'' then true else false end;',
'begin',
'    for l_theme in ( select theme_number',
'                       from apex_applications',
'                      where application_id  = :APP_ID )',
'    loop',
'        if l_enabled then',
'            apex_theme.enable_user_style (',
'                p_application_id => :APP_ID,',
'                p_theme_number   => l_theme.theme_number );',
'        else',
'            apex_theme.disable_user_style (',
'                p_application_id => :APP_ID,',
'                p_theme_number   => l_theme.theme_number );',
'            apex_theme.clear_all_users_style(:APP_ID);',
'        end if;',
'    end loop;',
'end;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_success_message=>'Application Appearance Settings Saved.'
,p_internal_uid=>3416820596037217209
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416820090476217209)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Save Theme Style'
,p_static_id=>'save-theme-style'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'if :P10020_DESKTOP_THEME_STYLE_ID is not null then',
'    for l_theme in (select theme_number',
'                      from apex_application_themes',
'                     where application_id = :app_id',
'                       and is_current     = ''Yes'')',
'    loop',
'        apex_util.set_current_theme_style (',
'            p_theme_number   => l_theme.theme_number,',
'            p_theme_style_id => :P10020_DESKTOP_THEME_STYLE_ID',
'            );',
'    end loop;',
'end if;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_success_message=>'Application Appearance Settings Saved.'
,p_internal_uid=>3416820090476217209
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10030
begin
wwv_flow_imp_page.create_page(
 p_id=>10030
,p_name=>'Activity Dashboard'
,p_alias=>'ACTIVITY-DASHBOARD'
,p_page_mode=>'MODAL'
,p_step_title=>'Activity Dashboard'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'03'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416821973970217210)
,p_plug_name=>'Filters'
,p_static_id=>'filters'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--slimPadding:t-ButtonRegion--noUI:t-Form--large'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416821195827217210)
,p_plug_name=>'Hourly Page Events'
,p_static_id=>'hourly-page-events'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:i-h320:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3416821284498217210)
,p_region_id=>wwv_flow_imp.id(3416821195827217210)
,p_chart_type=>'bar'
,p_lazy_loading=>true
,p_animation_on_data_change=>'auto'
,p_orientation=>'vertical'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_sorting=>'label-asc'
,p_fill_multi_series_gaps=>true
,p_zoom_and_scroll=>'off'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>false
,p_show_group_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_time_axis_type=>'enabled'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3416823669335217212)
,p_chart_id=>wwv_flow_imp.id(3416821284498217210)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'with nw as (',
'    -- APEX_ACTIVITY_LOG uses dates; convert system time to local time zone.',
'    select from_tz( cast( sysdate as timestamp ), to_char( systimestamp, ''TZR'' ) ) at local as tm from sys.dual',
'),',
'window as (',
'    select',
'         trunc(nw.tm - ((level-1)/24),''HH'') start_tm,',
'         trunc(nw.tm - ((level-2)/24),''HH'') end_tm,',
'         trunc(sysdate-((level-1)/24),''HH'') log_start_tm,',
'         trunc(sysdate-((level-2)/24),''HH'') log_end_tm',
'    from nw',
'    connect by level <= round( 24 * ( 1/24/60/60 * nvl(:P10030_TIMEFRAME,1) ) )',
')',
'select w.start_tm log_time,',
'       ( select count(*)',
'           from apex_activity_log l',
'          where l.flow_id = :app_id',
'            and l.time_stamp between w.log_start_tm and w.log_end_tm ) as value',
'from window w',
'order by 1'))
,p_max_row_count=>350
,p_ajax_items_to_submit=>'P10030_TIMEFRAME'
,p_series_type=>'bar'
,p_items_value_column_name=>'VALUE'
,p_items_label_column_name=>'LOG_TIME'
,p_assigned_to_y2=>'off'
,p_items_label_rendered=>false
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416825113471217213)
,p_chart_id=>wwv_flow_imp.id(3416821284498217210)
,p_static_id=>'x'
,p_axis=>'x'
,p_is_rendered=>'on'
,p_format_type=>'datetime-short'
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_major_tick_rendered=>'on'
,p_minor_tick_rendered=>'on'
,p_tick_label_rendered=>'on'
,p_tick_label_rotation=>'auto'
,p_tick_label_position=>'outside'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416824449711217212)
,p_chart_id=>wwv_flow_imp.id(3416821284498217210)
,p_static_id=>'y'
,p_axis=>'y'
,p_is_rendered=>'on'
,p_format_type=>'decimal'
,p_decimal_places=>0
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_position=>'auto'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3416821864310217210)
,p_name=>'Latest Activity'
,p_static_id=>'latest-activity'
,p_template=>4075786578761660127
,p_display_sequence=>50
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:i-h240:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--altRowsDefault:t-Report--rowHighlight:t-Report--inline'
,p_new_grid_row=>false
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select userid_lc       as username,',
'       max(time_stamp) as last_activity',
'  from apex_activity_log',
' where flow_id     = :app_id',
'   and time_stamp >= sysdate - ( 1/24/60/60 * :P10030_TIMEFRAME )',
'   and userid_lc  is not null',
' group by userid_lc',
' order by 2 desc'))
,p_ajax_enabled=>'Y'
,p_ajax_items_to_submit=>'P10030_TIMEFRAME'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>20
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No activities found'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416839495276217228)
,p_query_column_id=>2
,p_column_alias=>'LAST_ACTIVITY'
,p_column_display_sequence=>2
,p_column_heading=>'Last Activity'
,p_column_format=>'SINCE'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416838769551217227)
,p_query_column_id=>1
,p_column_alias=>'USERNAME'
,p_column_display_sequence=>1
,p_column_heading=>'Username'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416821391344217210)
,p_plug_name=>'Most Active Pages'
,p_static_id=>'most-active-pages'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:i-h320:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>30
,p_plug_new_grid_row=>false
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3416821487730217210)
,p_region_id=>wwv_flow_imp.id(3416821391344217210)
,p_chart_type=>'bar'
,p_lazy_loading=>true
,p_animation_on_data_change=>'auto'
,p_orientation=>'horizontal'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_sorting=>'label-asc'
,p_fill_multi_series_gaps=>true
,p_zoom_and_scroll=>'off'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>false
,p_show_group_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3416829885368217216)
,p_chart_id=>wwv_flow_imp.id(3416821487730217210)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select x.step_id||''. ''||(select page_name from apex_application_pages p where p.application_id = :app_id and page_id = x.step_id) label, ',
'        value',
'from ( select step_id,',
'              count(*) as value',
'         from apex_activity_log',
'        where flow_id = :app_id',
'          and time_stamp >= sysdate - ( 1/24/60/60 * :P10030_TIMEFRAME )',
'          and step_id is not null',
'        group by step_id',
'        order by 2 desc',
'     ) x'))
,p_max_row_count=>10
,p_ajax_items_to_submit=>'P10030_TIMEFRAME'
,p_series_type=>'bar'
,p_items_value_column_name=>'VALUE'
,p_items_label_column_name=>'LABEL'
,p_assigned_to_y2=>'off'
,p_items_label_rendered=>false
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416830566411217216)
,p_chart_id=>wwv_flow_imp.id(3416821487730217210)
,p_static_id=>'x'
,p_axis=>'x'
,p_is_rendered=>'on'
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_tick_label_rotation=>'auto'
,p_tick_label_position=>'outside'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416831278213217217)
,p_chart_id=>wwv_flow_imp.id(3416821487730217210)
,p_static_id=>'y'
,p_axis=>'y'
,p_is_rendered=>'on'
,p_format_type=>'decimal'
,p_decimal_places=>0
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_position=>'auto'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3416821735601217210)
,p_name=>'Recent Errors'
,p_static_id=>'recent-errors'
,p_template=>4075786578761660127
,p_display_sequence=>40
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:i-h240:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--altRowsDefault:t-Report--rowHighlight:t-Report--inline'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select sqlerrm    label,',
'       time_stamp value',
'  from apex_activity_log',
' where flow_id    = :app_id',
'   and time_stamp >= sysdate - ( 1/24/60/60 * :P10030_TIMEFRAME )',
'   and sqlerrm    is not null',
' order by 2 desc, 1'))
,p_ajax_enabled=>'Y'
,p_ajax_items_to_submit=>'P10030_TIMEFRAME'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>20
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416834267275217222)
,p_query_column_id=>1
,p_column_alias=>'LABEL'
,p_column_display_sequence=>1
,p_column_heading=>'Label'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416835266389217223)
,p_query_column_id=>2
,p_column_alias=>'VALUE'
,p_column_display_sequence=>2
,p_column_heading=>'Value'
,p_column_format=>'SINCE'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416821528596217210)
,p_plug_name=>'Top Users'
,p_static_id=>'top-users'
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:i-h320:t-Region--scrollBody'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4075786578761660127
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3416821693041217210)
,p_region_id=>wwv_flow_imp.id(3416821528596217210)
,p_chart_type=>'bar'
,p_lazy_loading=>true
,p_animation_on_data_change=>'auto'
,p_orientation=>'horizontal'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_sorting=>'label-asc'
,p_fill_multi_series_gaps=>true
,p_zoom_and_scroll=>'off'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>false
,p_show_group_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3416826769383217214)
,p_chart_id=>wwv_flow_imp.id(3416821693041217210)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select nvl( userid_lc, apex_lang.message(''APEX.FEATURE.TOP_USERS.USERNAME.NOT_IDENTIFIED'') ) as label,',
'       count(*) as value',
'from apex_activity_log',
'where flow_id = :app_id',
'and time_stamp >= sysdate - ( 1/24/60/60 * :P10030_TIMEFRAME )',
'group by nvl( userid_lc, apex_lang.message(''APEX.FEATURE.TOP_USERS.USERNAME.NOT_IDENTIFIED'') )',
'order by 2 desc'))
,p_max_row_count=>10
,p_ajax_items_to_submit=>'P10030_TIMEFRAME'
,p_series_type=>'bar'
,p_items_value_column_name=>'VALUE'
,p_items_label_column_name=>'LABEL'
,p_assigned_to_y2=>'off'
,p_items_label_rendered=>false
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416827441397217214)
,p_chart_id=>wwv_flow_imp.id(3416821693041217210)
,p_static_id=>'x'
,p_axis=>'x'
,p_is_rendered=>'on'
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_tick_label_rotation=>'auto'
,p_tick_label_position=>'outside'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_axis(
 p_id=>wwv_flow_imp.id(3416828266264217215)
,p_chart_id=>wwv_flow_imp.id(3416821693041217210)
,p_static_id=>'y'
,p_axis=>'y'
,p_is_rendered=>'on'
,p_format_type=>'decimal'
,p_decimal_places=>0
,p_format_scaling=>'auto'
,p_scaling=>'linear'
,p_baseline_scaling=>'zero'
,p_position=>'auto'
,p_major_tick_rendered=>'auto'
,p_minor_tick_rendered=>'auto'
,p_tick_label_rendered=>'on'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416841412891217230)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416821195827217210)
,p_button_name=>'VIEW_ACTIVITY_BY_USER'
,p_static_id=>'view-activity-by-user'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI'
,p_button_template_id=>2352535364915922073
,p_button_image_alt=>'View Details'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:10031:&APP_SESSION.::&DEBUG.:RP,10031::'
,p_icon_css_classes=>'fa-angle-right'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416842463134217231)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416821528596217210)
,p_button_name=>'VIEW_ACTIVITY_BY_USER2'
,p_static_id=>'view-activity-by-user2'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI'
,p_button_template_id=>2352535364915922073
,p_button_image_alt=>'View Details'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:10031:&APP_SESSION.::&DEBUG.:RP,10031::'
,p_icon_css_classes=>'fa-angle-right'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416841951775217230)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416821391344217210)
,p_button_name=>'VIEW_ACTIVITY_DETAILS'
,p_static_id=>'view-activity-details'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI'
,p_button_template_id=>2352535364915922073
,p_button_image_alt=>'View Details'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:10034:&APP_SESSION.::&DEBUG.:RP,10034::'
,p_icon_css_classes=>'fa-angle-right'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416842989977217231)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416821735601217210)
,p_button_name=>'VIEW_RECENT_ERRORS'
,p_static_id=>'view-recent-errors'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--noUI'
,p_button_template_id=>2352535364915922073
,p_button_image_alt=>'View Details'
,p_button_position=>'EDIT'
,p_button_redirect_url=>'f?p=&APP_ID.:10032:&APP_SESSION.::&DEBUG.:RP,10032::'
,p_icon_css_classes=>'fa-angle-right'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416822001471217210)
,p_name=>'P10030_TIMEFRAME'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416821973970217210)
,p_prompt=>'Timeframe'
,p_source=>'900'
,p_source_type=>'STATIC'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'TIMEFRAME (4 WEEKS)'
,p_cHeight=>1
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416822101153217210)
,p_name=>'Change Filters'
,p_static_id=>'change-filters'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P10030_TIMEFRAME'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416844941282217233)
,p_event_id=>wwv_flow_imp.id(3416822101153217210)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416821195827217210)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416845693074217233)
,p_event_id=>wwv_flow_imp.id(3416822101153217210)
,p_event_result=>'TRUE'
,p_action_sequence=>20
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh-2'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416821528596217210)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416846279398217234)
,p_event_id=>wwv_flow_imp.id(3416822101153217210)
,p_event_result=>'TRUE'
,p_action_sequence=>30
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh-3'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416821391344217210)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416846969384217234)
,p_event_id=>wwv_flow_imp.id(3416822101153217210)
,p_event_result=>'TRUE'
,p_action_sequence=>40
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh-4'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416821735601217210)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416847672689217235)
,p_event_id=>wwv_flow_imp.id(3416822101153217210)
,p_event_result=>'TRUE'
,p_action_sequence=>50
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh-5'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416821864310217210)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071410Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10031
begin
wwv_flow_imp_page.create_page(
 p_id=>10031
,p_name=>'Top Users'
,p_alias=>'TOP-USERS'
,p_page_mode=>'MODAL'
,p_step_title=>'Top Users'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_inline_css=>wwv_flow_string.join(wwv_flow_t_varchar2(
'.hour-graph { display: table; width: 100%; }',
'span.hour { display: table-cell; padding: 0; font-size: 11px; text-align: center; min-width: 32px; }',
'span.hour-label { opacity: 0.5; }',
'span.hour-value { display: block; }',
'span.hour { background-color: var(--ut-palette-success); color:  var(--ut-palette-success-contrast); }',
'span.hour.is-null { background-color: var(--ut-component-highlight-background-color); color: var(--ut-component-text-default-color); }',
'span.hour.is-over1k { background-color: var(--ut-palette-primary); color:  var(--ut-palette-primary-contrast); }'))
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Use this report and chart to see the users with the most page views for the specified timeframe.</p>',
'<p>Select the reporting timeframe (Default = 1 day) and choose between the report and chart icons at the top of the page.</p>',
'<p>For the interactive report, use the search field, or select the <strong>User</strong> column heading, to select a specific user. You can perform numerous functions by clicking the <strong>Actions</strong> button, such as columns displayed / hidden'
||', rows per page, filter, and so forth. Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416907144692217309)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--slimPadding:t-ButtonRegion--noUI:t-Form--large'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416907059701217309)
,p_plug_name=>'Top Users'
,p_static_id=>'top-users'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select the_user,',
'    ''<div class="hour-graph">''||',
'        ''<span class="hour''|| case when h00 = 0 then '' is-null'' when h00 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 0</span> <span class="hour-value">''|| ',
'        case when h00 > 999 then to_char((h00/1000),''99999999D0'') ||''k'' else to_char(h00) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h01 = 0 then '' is-null'' when h01 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 1</span> <span class="hour-value">''|| ',
'        case when h01 > 999 then to_char((h01/1000),''99999999D0'') ||''k'' else to_char(h01) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h02 = 0 then '' is-null'' when h02 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 2</span> <span class="hour-value">''|| ',
'        case when h02 > 999 then to_char((h02/1000),''99999999D0'') ||''k'' else to_char(h02) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h03 = 0 then '' is-null'' when h03 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 3</span> <span class="hour-value">''|| ',
'        case when h03 > 999 then to_char((h03/1000),''99999999D0'') ||''k'' else to_char(h03) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h04 = 0 then '' is-null'' when h04 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 4</span> <span class="hour-value">''|| ',
'        case when h04 > 999 then to_char((h04/1000),''99999999D0'') ||''k'' else to_char(h04) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h05 = 0 then '' is-null'' when h05 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 5</span> <span class="hour-value">''|| ',
'        case when h05 > 999 then to_char((h05/1000),''99999999D0'') ||''k'' else to_char(h05) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h06 = 0 then '' is-null'' when h06 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 6</span> <span class="hour-value">''|| ',
'        case when h06 > 999 then to_char((h06/1000),''99999999D0'') ||''k'' else to_char(h06) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h07 = 0 then '' is-null'' when h07 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 7</span> <span class="hour-value">''|| ',
'        case when h07 > 999 then to_char((h07/1000),''99999999D0'') ||''k'' else to_char(h07) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h08 = 0 then '' is-null'' when h08 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 8</span> <span class="hour-value">''|| ',
'        case when h08 > 999 then to_char((h08/1000),''99999999D0'') ||''k'' else to_char(h08) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h09 = 0 then '' is-null'' when h09 > 999 then '' is-over1k'' end ||''"><span class="hour-label"> 9</span> <span class="hour-value">''|| ',
'        case when h09 > 999 then to_char((h09/1000),''99999999D0'') ||''k'' else to_char(h09) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h10 = 0 then '' is-null'' when h10 > 999 then '' is-over1k'' end ||''"><span class="hour-label">10</span> <span class="hour-value">''|| ',
'        case when h10 > 999 then to_char((h10/1000),''99999999D0'') ||''k'' else to_char(h10) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h11 = 0 then '' is-null'' when h11 > 999 then '' is-over1k'' end ||''"><span class="hour-label">11</span> <span class="hour-value">''|| ',
'        case when h11 > 999 then to_char((h11/1000),''99999999D0'') ||''k'' else to_char(h11) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h12 = 0 then '' is-null'' when h12 > 999 then '' is-over1k'' end ||''"><span class="hour-label">12</span> <span class="hour-value">''|| ',
'        case when h12 > 999 then to_char((h12/1000),''99999999D0'') ||''k'' else to_char(h12) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h13 = 0 then '' is-null'' when h13 > 999 then '' is-over1k'' end ||''"><span class="hour-label">13</span> <span class="hour-value">''|| ',
'        case when h13 > 999 then to_char((h13/1000),''99999999D0'') ||''k'' else to_char(h13) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h14 = 0 then '' is-null'' when h14 > 999 then '' is-over1k'' end ||''"><span class="hour-label">14</span> <span class="hour-value">''|| ',
'        case when h14 > 999 then to_char((h14/1000),''99999999D0'') ||''k'' else to_char(h14) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h15 = 0 then '' is-null'' when h15 > 999 then '' is-over1k'' end ||''"><span class="hour-label">15</span> <span class="hour-value">''|| ',
'        case when h15 > 999 then to_char((h15/1000),''99999999D0'') ||''k'' else to_char(h15) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h16 = 0 then '' is-null'' when h16 > 999 then '' is-over1k'' end ||''"><span class="hour-label">16</span> <span class="hour-value">''|| ',
'        case when h16 > 999 then to_char((h16/1000),''99999999D0'') ||''k'' else to_char(h16) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h17 = 0 then '' is-null'' when h17 > 999 then '' is-over1k'' end ||''"><span class="hour-label">17</span> <span class="hour-value">''|| ',
'        case when h17 > 999 then to_char((h17/1000),''99999999D0'') ||''k'' else to_char(h17) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h18 = 0 then '' is-null'' when h18 > 999 then '' is-over1k'' end ||''"><span class="hour-label">18</span> <span class="hour-value">''|| ',
'        case when h18 > 999 then to_char((h18/1000),''99999999D0'') ||''k'' else to_char(h18) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h19 = 0 then '' is-null'' when h19 > 999 then '' is-over1k'' end ||''"><span class="hour-label">19</span> <span class="hour-value">''|| ',
'        case when h19 > 999 then to_char((h19/1000),''99999999D0'') ||''k'' else to_char(h19) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h20 = 0 then '' is-null'' when h20 > 999 then '' is-over1k'' end ||''"><span class="hour-label">20</span> <span class="hour-value">''|| ',
'        case when h20 > 999 then to_char((h20/1000),''99999999D0'') ||''k'' else to_char(h20) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h21 = 0 then '' is-null'' when h21 > 999 then '' is-over1k'' end ||''"><span class="hour-label">21</span> <span class="hour-value">''|| ',
'        case when h21 > 999 then to_char((h21/1000),''99999999D0'') ||''k'' else to_char(h21) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h22 = 0 then '' is-null'' when h22 > 999 then '' is-over1k'' end ||''"><span class="hour-label">22</span> <span class="hour-value">''|| ',
'        case when h22 > 999 then to_char((h22/1000),''99999999D0'') ||''k'' else to_char(h22) end ||''</span></span>''||',
'        ''<span class="hour''|| case when h23 = 0 then '' is-null'' when h23 > 999 then '' is-over1k'' end ||''"><span class="hour-label">23</span> <span class="hour-value">''|| ',
'        case when h23 > 999 then to_char((h23/1000),''99999999D0'') ||''k'' else to_char(h23) end ||''</span></span>''||',
'        ''</div>'' hours,',
'        page_events,',
'    median_elapsed,',
'    rows_fetched,',
'    ir_searches,',
'    errors,',
'    most_recent',
'    from (  ',
'    select userid_lc                    as the_user,',
'        count(*)                        as page_events,',
'        median(elap)                    as median_elapsed,',
'        sum(num_rows)                   as rows_fetched,',
'        sum(decode(ir_search,null,0,1)) as ir_searches,',
'        sum(decode(sqlerrm,null,0,1))   as errors,',
'        max(time_stamp)                 as most_recent,',
'        sum(decode(to_char(time_stamp,''HH24''),0,1,0)) h00,',
'        sum(decode(to_char(time_stamp,''HH24''),1,1,0)) h01,',
'        sum(decode(to_char(time_stamp,''HH24''),2,1,0)) h02,',
'        sum(decode(to_char(time_stamp,''HH24''),3,1,0)) h03,',
'        sum(decode(to_char(time_stamp,''HH24''),4,1,0)) h04,',
'        sum(decode(to_char(time_stamp,''HH24''),5,1,0)) h05,',
'        sum(decode(to_char(time_stamp,''HH24''),6,1,0)) h06,',
'        sum(decode(to_char(time_stamp,''HH24''),7,1,0)) h07,',
'        sum(decode(to_char(time_stamp,''HH24''),8,1,0)) h08,',
'        sum(decode(to_char(time_stamp,''HH24''),9,1,0)) h09,',
'        sum(decode(to_char(time_stamp,''HH24''),10,1,0)) h10,',
'        sum(decode(to_char(time_stamp,''HH24''),11,1,0)) h11,',
'        sum(decode(to_char(time_stamp,''HH24''),12,1,0)) h12,',
'        sum(decode(to_char(time_stamp,''HH24''),13,1,0)) h13,',
'        sum(decode(to_char(time_stamp,''HH24''),14,1,0)) h14,',
'        sum(decode(to_char(time_stamp,''HH24''),15,1,0)) h15,',
'        sum(decode(to_char(time_stamp,''HH24''),16,1,0)) h16,',
'        sum(decode(to_char(time_stamp,''HH24''),17,1,0)) h17,',
'        sum(decode(to_char(time_stamp,''HH24''),18,1,0)) h18,',
'        sum(decode(to_char(time_stamp,''HH24''),19,1,0)) h19,',
'        sum(decode(to_char(time_stamp,''HH24''),20,1,0)) h20,',
'        sum(decode(to_char(time_stamp,''HH24''),21,1,0)) h21,',
'        sum(decode(to_char(time_stamp,''HH24''),22,1,0)) h22,',
'        sum(decode(to_char(time_stamp,''HH24''),23,1,0)) h23',
'    from apex_activity_log l',
'    where flow_id = :APP_ID',
'        and time_stamp >= sysdate - ( 1/24/60/60 * :P10031_TIMEFRAME )',
'        and userid is not null',
'    group by userid_lc) x'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416908272939217309)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416908272939217309
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416918113472217328)
,p_db_column_name=>'ERRORS'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Errors'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416913160688217319)
,p_db_column_name=>'HOURS'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Activity by Hour'
,p_column_type=>'STRING'
,p_display_text_as=>'WITHOUT_MODIFICATION'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416917155059217326)
,p_db_column_name=>'IR_SEARCHES'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'IR Search'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416915205993217322)
,p_db_column_name=>'MEDIAN_ELAPSED'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Median Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D0000'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416919114254217329)
,p_db_column_name=>'MOST_RECENT'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Most_Recent'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'SINCE'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416914272998217321)
,p_db_column_name=>'PAGE_EVENTS'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Page Events'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416916259251217324)
,p_db_column_name=>'ROWS_FETCHED'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Rows Fetched'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416912002396217317)
,p_db_column_name=>'THE_USER'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'User'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416924975366217338)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'THE_USER:HOURS:PAGE_EVENTS'
,p_sort_column_1=>'PAGE_EVENTS'
,p_sort_direction_1=>'DESC'
,p_sort_column_2=>'MOST_RECENT'
,p_sort_direction_2=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416907393261217309)
,p_plug_name=>'Top Users Chart'
,p_static_id=>'top-users-chart'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_location=>null
,p_plug_source_type=>'NATIVE_JET_CHART'
,p_plug_query_num_rows=>15
,p_plug_display_condition_type=>'VAL_OF_ITEM_IN_COND_EQ_COND2'
,p_plug_display_when_condition=>'P10031_VIEW_AS'
,p_plug_display_when_cond2=>'CHART'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(3416907464492217309)
,p_region_id=>wwv_flow_imp.id(3416907393261217309)
,p_chart_type=>'donut'
,p_height=>'600'
,p_lazy_loading=>true
,p_animation_on_data_change=>'auto'
,p_data_cursor=>'auto'
,p_data_cursor_behavior=>'auto'
,p_hover_behavior=>'dim'
,p_stack=>'off'
,p_stack_label=>'off'
,p_connect_nulls=>'Y'
,p_value_format_type=>'decimal'
,p_value_decimal_places=>0
,p_value_format_scaling=>'auto'
,p_tooltip_rendered=>'Y'
,p_show_series_name=>true
,p_show_value=>true
,p_legend_rendered=>'off'
,p_overview_rendered=>'off'
,p_pie_other_threshold=>.02
,p_pie_selection_effect=>'highlight'
,p_javascript_code=>wwv_flow_string.join(wwv_flow_t_varchar2(
'function( options ){ ',
'',
'    this.pieSliceLabel = function(dataContext) {',
'        var series_name,',
'            percent = Math.round(dataContext.value/dataContext.totalValue*100);',
'        ',
'        if ( dataContext.seriesData ) {',
'            series_name = dataContext.seriesData.name;',
'        } else {',
'            series_name = ''Other'';',
'        }',
'        return series_name + " " + percent + "% ( " + dataContext.value + " )";',
'    }',
'    ',
'    // Set chart initialization options ',
'    options.dataLabel = pieSliceLabel; ',
'    return options; ',
'}'))
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_jet_chart_series(
 p_id=>wwv_flow_imp.id(3416929781382217344)
,p_chart_id=>wwv_flow_imp.id(3416907464492217309)
,p_static_id=>'series-1'
,p_seq=>10
,p_name=>'Series 1'
,p_data_source_type=>'SQL'
,p_data_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select userid_lc as userid,',
'       count(*) as page_views',
'  from apex_activity_log',
' where flow_id     = :app_id',
'   and time_stamp >= sysdate - ( 1/24/60/60 * :P10031_TIMEFRAME )',
'   and userid     is not null',
' group by userid_lc',
' order by 2'))
,p_ajax_items_to_submit=>'P10031_TIMEFRAME'
,p_series_type=>'donut'
,p_items_value_column_name=>'PAGE_VIEWS'
,p_items_label_column_name=>'USERID'
,p_items_label_rendered=>true
,p_items_label_position=>'outsideSlice'
,p_items_label_display_as=>'LABEL'
,p_threshold_display=>'onIndicator'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416907753351217309)
,p_name=>'P10031_TIMEFRAME'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416907144692217309)
,p_prompt=>'Timeframe'
,p_source=>'900'
,p_source_type=>'STATIC'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'TIMEFRAME (4 WEEKS)'
,p_cHeight=>1
,p_field_template=>2322028657308407345
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416907506501217309)
,p_name=>'P10031_VIEW_AS'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416907144692217309)
,p_prompt=>'View As'
,p_source=>'REPORT'
,p_source_type=>'STATIC'
,p_display_as=>'NATIVE_RADIOGROUP'
,p_named_lov=>'VIEW_AS_REPORT_CHART'
,p_field_template=>2044213549383960320
,p_item_template_options=>'#DEFAULT#:t-Form-fieldContainer--radioButtonGroup'
,p_lov_display_extra=>'NO'
,p_escape_on_http_output=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'execute_validations', 'Y',
  'number_of_columns', '2',
  'page_action_on_selection', 'SUBMIT')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416907213224217309)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P10031_TIMEFRAME'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416927641265217341)
,p_event_id=>wwv_flow_imp.id(3416907213224217309)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416907059701217309)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416932738752217347)
,p_event_id=>wwv_flow_imp.id(3416907213224217309)
,p_event_result=>'TRUE'
,p_action_sequence=>30
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh-2'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416907059701217309)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10032
begin
wwv_flow_imp_page.create_page(
 p_id=>10032
,p_name=>'Application Error Log'
,p_alias=>'APPLICATION-ERROR-LOG'
,p_page_mode=>'MODAL'
,p_step_title=>'Application Error Log'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>This page provides an interactive report of all unexpected errors logged by this application.</p>',
'<p>Click on the column headings to sort and filter data, or click on the <strong>Actions</strong> button to customize column display and many additional advanced features. Click the <strong>Reset</strong> button to reset the interactive report back t'
||'o the default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416894330644217293)
,p_plug_name=>'Application Error Log'
,p_static_id=>'application-error-log'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select step_id,',
'       userid,',
'       time_stamp err_time,',
'       sqlerrm,',
'       sqlerrm_component_type,',
'       sqlerrm_component_name',
'  from apex_activity_log',
' where flow_id = :app_id',
'   and sqlerrm is not null'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416895037002217293)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416895037002217293
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416899810372217301)
,p_db_column_name=>'ERR_TIME'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Err Time'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416900782473217302)
,p_db_column_name=>'SQLERRM'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Error'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416902445480217304)
,p_db_column_name=>'SQLERRM_COMPONENT_NAME'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Component Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416901545870217303)
,p_db_column_name=>'SQLERRM_COMPONENT_TYPE'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Context'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416897972998217297)
,p_db_column_name=>'STEP_ID'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'Page'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416899097975217299)
,p_db_column_name=>'USERID'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'User'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416906004838217308)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'STEP_ID:USERID:ERR_TIME:SQLERRM:SQLERRM_COMPONENT_TYPE:SQLERRM_COMPONENT_NAME:'
,p_sort_column_1=>'ERROR_TIME'
,p_sort_direction_1=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10033
begin
wwv_flow_imp_page.create_page(
 p_id=>10033
,p_name=>'Page Performance'
,p_alias=>'PAGE-PERFORMANCE'
,p_page_mode=>'MODAL'
,p_step_title=>'Page Performance'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>This page provides an interactive report of the page performance and popularity. The report is ordered by <strong>Weighted Performance</strong> which is calculated by multiplying the Median Elapsed time and number of Page Views.</p>',
'<p>Select the reporting timeframe (Default = 1 day) at the top of the page as necessary.<br>',
'Click on the column headings to sort and filter data, or click on the <strong>Actions</strong> button to customize column display and many additional advanced features. Click the <strong>Reset</strong> button to reset the interactive report back to t'
||'he default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416868813985217261)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--slimPadding:t-ButtonRegion--noUI:t-Form--large'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416868748779217261)
,p_plug_name=>'Page Performance'
,p_static_id=>'page-performance'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select step_id page,',
'    (   select page_name',
'        from apex_application_pages p',
'        where p.page_id = l.step_id',
'            and p.application_id = :app_id ) page_name,',
'    median(elap)                   median_elapsed,',
'    count(*) * median(elap)        weighted_performance,',
'    sum(decode(sqlerrm,null,0,1))  errors,',
'    count(distinct userid)         distinct_users,',
'    count(distinct session_id)     application_sessions,',
'    count(*)                       page_views,',
'    max(elap)                      max_elapsed,',
'    sum(nvl(num_rows,0))           total_rows,',
'    sum(decode(page_mode,''P'',1,0)) partial_page_views,',
'    sum(decode(page_mode,''D'',1,0)) full_page_views,',
'    min(elap)                      min_elapsed,',
'    avg(elap)                      avg_elapsed',
'from apex_activity_log l',
'where flow_id = :app_id',
'    and time_stamp >= sysdate - ( 1/24/60/60 * :P10033_TIMEFRAME )',
'    and userid is not null',
'group by step_id'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416869480557217261)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416869480557217261
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416877980656217274)
,p_db_column_name=>'APPLICATION_SESSIONS'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Application Sessions'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416883771075217283)
,p_db_column_name=>'AVG_ELAPSED'
,p_display_order=>14
,p_column_identifier=>'N'
,p_column_label=>'Avg Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D9999'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416877122658217273)
,p_db_column_name=>'DISTINCT_USERS'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Distinct Users'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416876242087217272)
,p_db_column_name=>'ERRORS'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Errors'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416882163237217280)
,p_db_column_name=>'FULL_PAGE_VIEWS'
,p_display_order=>12
,p_column_identifier=>'L'
,p_column_label=>'Full Page Views'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416879630090217277)
,p_db_column_name=>'MAX_ELAPSED'
,p_display_order=>9
,p_column_identifier=>'I'
,p_column_label=>'Max Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D9999'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416874566078217269)
,p_db_column_name=>'MEDIAN_ELAPSED'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Median Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D9999'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416882939816217282)
,p_db_column_name=>'MIN_ELAPSED'
,p_display_order=>13
,p_column_identifier=>'M'
,p_column_label=>'Min Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D9999'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416872497132217266)
,p_db_column_name=>'PAGE'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'Page'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416873455553217268)
,p_db_column_name=>'PAGE_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Page Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416878702207217276)
,p_db_column_name=>'PAGE_VIEWS'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Page Views'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416881224188217279)
,p_db_column_name=>'PARTIAL_PAGE_VIEWS'
,p_display_order=>11
,p_column_identifier=>'K'
,p_column_label=>'Partial Page Views'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416880456486217278)
,p_db_column_name=>'TOTAL_ROWS'
,p_display_order=>10
,p_column_identifier=>'J'
,p_column_label=>'Total Rows'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416875405121217271)
,p_db_column_name=>'WEIGHTED_PERFORMANCE'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Weighted Performance'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D99'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416890989052217289)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'PAGE:PAGE_NAME:MEDIAN_ELAPSED:WEIGHTED_PERFORMANCE:ERRORS:DISTINCT_USERS:APPLICATION_SESSIONS:PAGE_VIEWS'
,p_sort_column_1=>'WEIGHTED_PERFORMANCE'
,p_sort_direction_1=>'DESC'
,p_sort_column_2=>'PAGE_VIEWS'
,p_sort_direction_2=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416868640305217261)
,p_name=>'P10033_TIMEFRAME'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416868813985217261)
,p_prompt=>'Timeframe'
,p_source=>'900'
,p_source_type=>'STATIC'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'TIMEFRAME (4 WEEKS)'
,p_cHeight=>1
,p_field_template=>2322028657308407345
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416868983824217261)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P10033_TIMEFRAME'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416893394758217292)
,p_event_id=>wwv_flow_imp.id(3416868983824217261)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416868748779217261)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10034
begin
wwv_flow_imp_page.create_page(
 p_id=>10034
,p_name=>'Page Views'
,p_alias=>'PAGE-VIEWS'
,p_page_mode=>'MODAL'
,p_step_title=>'Page Views'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>This page provides an interactive report of the most recent page views.</p>',
'<p>Select the reporting timeframe (Default = 1 day) at the top of the page as necessary.<br>',
'Click on the column headings to sort and filter data, or click on the <strong>Actions</strong> button to customize column display and many additional advanced features. Click the <strong>Reset</strong> button to reset the interactive report back to t'
||'he default settings.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416848611924217236)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#:t-ButtonRegion--slimPadding:t-ButtonRegion--noUI:t-Form--large'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416848562758217236)
,p_plug_name=>'Page Views'
,p_static_id=>'page-views'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select ',
'    step_id||''. ''||(select page_name',
'                    from apex_application_pages p',
'                    where p.page_id = l.step_id',
'                        and p.application_id = :APP_ID) page_name,',
'    userid_lc     user_id,',
'    time_stamp    timestamp,',
'    elap          elapsed,',
'    step_id       page,',
'    decode(page_mode,''P'',''Partial'',''D'',''Full'',page_mode) page_mode,',
'    component_name,',
'    num_rows,',
'    ir_search,',
'    sqlerrm  error',
'from apex_activity_log l',
'where flow_id = :app_id',
'    and time_stamp >= sysdate - ( 1/24/60/60 * :P10034_TIMEFRAME )',
'    and userid is not null',
'    and step_id is not null',
'order by time_stamp desc'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416849274979217236)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416849274979217236
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416857629485217250)
,p_db_column_name=>'COMPONENT_NAME'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Component Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416855121457217246)
,p_db_column_name=>'ELAPSED'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Elapsed'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990D0000'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416860250826217253)
,p_db_column_name=>'ERROR'
,p_display_order=>10
,p_column_identifier=>'J'
,p_column_label=>'Error'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416859372614217252)
,p_db_column_name=>'IR_SEARCH'
,p_display_order=>9
,p_column_identifier=>'I'
,p_column_label=>'IR Search'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416858590394217251)
,p_db_column_name=>'NUM_ROWS'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Num Rows'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_format_mask=>'999G999G999G999G999G990'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416855952134217247)
,p_db_column_name=>'PAGE'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Page'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416856853857217248)
,p_db_column_name=>'PAGE_MODE'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Mode'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416852414184217241)
,p_db_column_name=>'PAGE_NAME'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'Page Name'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416854258263217244)
,p_db_column_name=>'TIMESTAMP'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Timestamp'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'SINCE'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416853452145217243)
,p_db_column_name=>'USER_ID'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'User'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071410Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416865435655217258)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'PAGE_NAME:USER_ID:TIMESTAMP:ELAPSED:PAGE_MODE'
,p_sort_column_1=>'TIMESTAMP'
,p_sort_direction_1=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416848473840217236)
,p_name=>'P10034_TIMEFRAME'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416848611924217236)
,p_prompt=>'Timeframe'
,p_source=>'900'
,p_source_type=>'STATIC'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'TIMEFRAME (4 WEEKS)'
,p_cHeight=>1
,p_field_template=>2322028657308407345
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416848731228217236)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P10034_TIMEFRAME'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416867907844217261)
,p_event_id=>wwv_flow_imp.id(3416848731228217236)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416848562758217236)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071411Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10035
begin
wwv_flow_imp_page.create_page(
 p_id=>10035
,p_name=>'Automations Log'
,p_alias=>'AUTOMATIONS-LOG'
,p_page_mode=>'MODAL'
,p_step_title=>'Automations Log'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>This page provides an interactive report of the automations log.</p>',
'<p>Review logged information about previous automation executions. The log contains start and end timestamps as well as details about processed rows (successful and with errors). Drill down into Messages to see individual messages for processed rows.'
||'</p>',
''))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416933454014217347)
,p_plug_name=>'Automations Log'
,p_static_id=>'automations-log'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select l.id,',
'       l.start_timestamp,',
'       a.name automation_name,',
'       l.status,',
'       l.successful_row_count,',
'       l.error_row_count,',
'       (select count(1) from apex_automation_msg_log m where m.automation_log_id = l.id) msg_count,',
'       l.is_job,',
'       l.end_timestamp',
'  from apex_appl_automations a, apex_automation_log l',
' where a.automation_id = l.automation_id',
' and l.application_id = :APP_ID'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416934107305217348)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'N'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_internal_uid=>3416934107305217348
,p_created_on=>wwv_flow_imp.dz('20261014071411Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416939236995217357)
,p_db_column_name=>'AUTOMATION_NAME'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Automation'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416943974218217365)
,p_db_column_name=>'END_TIMESTAMP'
,p_display_order=>9
,p_column_identifier=>'I'
,p_column_label=>'Ended'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416941582472217361)
,p_db_column_name=>'ERROR_ROW_COUNT'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Error Rows'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416937447557217354)
,p_db_column_name=>'ID'
,p_display_order=>1
,p_column_identifier=>'A'
,p_column_label=>'ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416943011109217364)
,p_db_column_name=>'IS_JOB'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Scheduled'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416942234691217362)
,p_db_column_name=>'MSG_COUNT'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'Message'
,p_column_link=>'f?p=&APP_ID.:10036:&APP_SESSION.::&DEBUG.:RP,10036:P10036_LOG_ID:#ID#'
,p_column_linktext=>'#MSG_COUNT#'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416938340864217356)
,p_db_column_name=>'START_TIMESTAMP'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Started'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416940084483217358)
,p_db_column_name=>'STATUS'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Status'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416940791919217360)
,p_db_column_name=>'SUCCESSFUL_ROW_COUNT'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Successful Rows'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416948428437217370)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'START_TIMESTAMP:AUTOMATION_NAME:STATUS:SUCCESSFUL_ROW_COUNT:ERROR_ROW_COUNT:MSG_COUNT'
,p_sort_column_1=>'START_TIMESTAMP'
,p_sort_direction_1=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10036
begin
wwv_flow_imp_page.create_page(
 p_id=>10036
,p_name=>'Log Messages'
,p_alias=>'LOG-MESSAGES'
,p_page_mode=>'MODAL'
,p_step_title=>'Log Messages'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218884799210834)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'03'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416949812000217371)
,p_plug_name=>'Automation Execution'
,p_static_id=>'automation-execution'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3416953053496217374)
,p_name=>'Messages'
,p_static_id=>'messages'
,p_template=>2103954283454391425
,p_display_sequence=>10
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--altRowsDefault:t-Report--rowHighlight:t-Report--inline'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select message_timestamp,',
'       message,',
'       message_type,',
'       pk_value',
'  from apex_automation_msg_log',
' where automation_log_id = :P10036_LOG_ID'))
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>15
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_query_row_count_max=>50
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416955445474217378)
,p_query_column_id=>2
,p_column_alias=>'MESSAGE'
,p_column_display_sequence=>2
,p_column_heading=>'Message'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416954615475217377)
,p_query_column_id=>1
,p_column_alias=>'MESSAGE_TIMESTAMP'
,p_column_display_sequence=>1
,p_column_heading=>'Timestamp'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_default_sort_dir=>'desc'
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416956074261217379)
,p_query_column_id=>3
,p_column_alias=>'MESSAGE_TYPE'
,p_column_display_sequence=>3
,p_column_heading=>'Message Type'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416956768539217380)
,p_query_column_id=>4
,p_column_alias=>'PK_VALUE'
,p_column_display_sequence=>4
,p_column_heading=>'Primary Key Value'
,p_heading_alignment=>'LEFT'
,p_default_sort_column_sequence=>1
,p_disable_sort_column=>'N'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416950992875217372)
,p_name=>'P10036_AUTOMATION_NAME'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416949812000217371)
,p_prompt=>'Automation'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_begin_on_new_line=>'N'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416950392426217372)
,p_name=>'P10036_LOG_ID'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416949812000217371)
,p_use_cache_before_default=>'NO'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416951582124217373)
,p_name=>'P10036_START_TIMESTAMP'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416949812000217371)
,p_prompt=>'Started'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_begin_on_new_line=>'N'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416952054681217373)
,p_name=>'P10036_STATUS'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416949812000217371)
,p_prompt=>'Status'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_begin_on_new_line=>'N'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416952580267217373)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Get Log Detail'
,p_static_id=>'get-log-detail'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select automation_name,',
'       start_timestamp,',
'       status',
'  into :P10036_AUTOMATION_NAME,',
'       :P10036_START_TIMESTAMP,',
'       :P10036_STATUS',
'  from apex_automation_log',
' where id = :P10036_LOG_ID;'))
,p_process_clob_language=>'PLSQL'
,p_internal_uid=>3416952580267217373
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10040
begin
wwv_flow_imp_page.create_page(
 p_id=>10040
,p_name=>'Configure Access Control'
,p_alias=>'CONFIGURE-ACCESS-CONTROL'
,p_page_mode=>'MODAL'
,p_step_title=>'Configure Access Control'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'U'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Select the appropriate choice for any authenticated users.<br> ',
'Selecting <strong>No</strong> makes the application more secure as only specified users can access the application. ',
'However, if your application has a large user community then maintaining users may be onerous, and you may prefer to choose <strong>Yes</strong> and only enter application Administrators, and possibly Contributors.<br>',
'If you select <strong>Yes</strong> then you must also select how users not included in the users list are treated.</p>',
'<p>Select between requiring email addresses and any alphanumeric value for Usernames.<br>',
'Generally, you should set this setting to <strong>E-mail Address</strong> if your application uses (or will be configured to use) a centralized authentication scheme such as Oracle Access Manager, or SSO.</p>',
'<p><em><strong>Note:</strong> This application supports the following 3 access levels: Reader, Contributor, and Administrator.',
'<ul>',
'  <li><strong>Readers</strong> have read-only access to all information and can also view reports.</li>',
'  <li><strong>Contributors</strong> can create, edit and delete information and view reports.</li>',
'  <li><strong>Administrators</strong>, in addition to Contributors capability, can also perform configuration of the application by accessing the Administration section of the application.</li>',
'</ul>',
'</em></p>'))
,p_page_component_map=>'16'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416959435925217383)
,p_plug_name=>'Access Control Configuration'
,p_static_id=>'access-control-configuration'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416959548646217383)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416961055679217384)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416959548646217383)
,p_button_name=>'APPLY_CHANGES'
,p_static_id=>'apply-changes'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'CREATE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416961632555217385)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416959548646217383)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416962280505217385)
,p_button_id=>wwv_flow_imp.id(3416961632555217385)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(3416963065865217386)
,p_branch_name=>'Branch to Admin Page'
,p_branch_action=>'f?p=&APP_ID.:10000:&APP_SESSION.::&DEBUG.:::&success_msg=#SUCCESS_MSG#'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>10
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416963356287217386)
,p_name=>'P10040_ALLOW_OTHER_USERS'
,p_is_required=>true
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416959435925217383)
,p_prompt=>'Any authenticated user may access this application'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'if apex_app_setting.get_value( p_name => ''ACCESS_CONTROL_SCOPE'' ) = ''ACL_ONLY'' then',
'    return ''N'';',
'else',
'    return ''Y'';',
'end if;'))
,p_source_type=>'FUNCTION_BODY'
,p_source_language=>'PLSQL'
,p_display_as=>'NATIVE_YES_NO'
,p_grid_label_column_span=>3
,p_field_template=>2322028657308407345
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_inline_help_text=>'Choose <strong>No</strong> if all users are defined in the access control list. Choose <strong>Yes</strong> if authenticated users not in the access control list may also use this application.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'use_defaults', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416964071831217386)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Set Access Control'
,p_static_id=>'set-access-control'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'begin',
'    if :P10040_ALLOW_OTHER_USERS = ''Y'' then',
'        apex_app_setting.set_value (',
'            p_name  => ''ACCESS_CONTROL_SCOPE'',',
'            p_value => ''ALL_USERS'');',
'    else',
'        apex_app_setting.set_value (',
'            p_name  => ''ACCESS_CONTROL_SCOPE'',',
'            p_value => ''ACL_ONLY'');',
'    end if;',
'end;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_success_message=>'Access Control settings saved.'
,p_internal_uid=>3416964071831217386
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10041
begin
wwv_flow_imp_page.create_page(
 p_id=>10041
,p_name=>'Manage User Access'
,p_alias=>'MANAGE-USER-ACCESS'
,p_page_mode=>'MODAL'
,p_step_title=>'Manage User Access'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>This page shows a report of the application users and the access level granted.</p>',
'<p>Click on the column headings to sort and filter data, or click on the <strong>Actions</strong> button to customize column display and many additional advanced features.<br>',
'Click the <strong>Reset</strong> button to reset the interactive report back to the default settings.</p>',
'<p>Click the edit icon (yellow pencil) to edit the user details and access level, or to delete the user.</p>',
'<p>Click <strong>Add User</strong>, at the top of the report, to add a new user and their access level.</p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416964599762217387)
,p_plug_name=>'Manage User Access'
,p_static_id=>'manage-user-access'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select id,',
'   user_name_lc USERNAME,',
'   role_names ACCESS_ROLE',
'from APEX_APPL_ACL_USERS',
'where APPLICATION_ID = :APP_ID'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3416965485663217387)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:10042:&APP_SESSION.::&DEBUG.:RP:P10042_ID:\#ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3416965485663217387
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416969579215217396)
,p_db_column_name=>'ACCESS_ROLE'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Roles'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416967909465217393)
,p_db_column_name=>'ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3416968876932217395)
,p_db_column_name=>'USERNAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Username'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3416971845821217398)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'USERNAME:ACCESS_ROLE'
,p_sort_column_2=>'USERNAME'
,p_sort_direction_2=>'ASC'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416972773426217399)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416964599762217387)
,p_button_name=>'ADD_MULTIPLE_USERS'
,p_static_id=>'add-multiple-users'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Add Multiple Users'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:10043:&APP_SESSION.::&DEBUG.:10043::'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416973279268217399)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416964599762217387)
,p_button_name=>'ADD_USER'
,p_static_id=>'add-user'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Add User'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:10042:&APP_SESSION.::&DEBUG.:10042::'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3416964665149217387)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3416964599762217387)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3416974111313217400)
,p_event_id=>wwv_flow_imp.id(3416964665149217387)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3416964599762217387)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10042
begin
wwv_flow_imp_page.create_page(
 p_id=>10042
,p_name=>'Manage User Access'
,p_alias=>'MANAGE-USER-ACCESS1'
,p_page_mode=>'MODAL'
,p_step_title=>'Manage User Access'
,p_first_item=>'AUTO_FIRST_ITEM'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Use this form to enter users, their email address and set their access level. ',
'The settings defined under <em>Configure Access Control</em> will determine whether the username must be their email address or can be any alphanumeric entry.</p>',
'<p>This application supports the following 3 access levels: Reader, Contributor, and Administrator.</p>',
'<ul>',
'  <li><strong>Readers</strong> have read-only access to all information and can also view reports.</li>',
'  <li><strong>Contributors</strong> can create, edit and delete information and view reports.</li>',
'  <li><strong>Administrators</strong>, in addition to Contributors capability, can also perform configuration of the application by accessing the Administration section of the application.</li>',
'</ul>',
'<p>When editing an existing user you can lock their account which will prevent them from accessing the application.</p>',
'<p><em><strong>Note:</strong>   If using Oracle APEX accounts then users entered here must also be defined as end users by a Workspace Administrator, who can also set their password.</em></p>'))
,p_page_component_map=>'02'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416974913478217401)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416974884428217401)
,p_plug_name=>'Form on Manage User Access'
,p_static_id=>'form-on-manage-user-access'
,p_region_template_options=>'#DEFAULT#:t-Form--stretchInputs'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'APEX_APPL_ACL_USERS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416976574816217403)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416974913478217401)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416977045738217403)
,p_button_id=>wwv_flow_imp.id(3416976574816217403)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416978733412217404)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(3416974913478217401)
,p_button_name=>'CREATE'
,p_static_id=>'create'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Add User'
,p_button_position=>'NEXT'
,p_button_condition=>'P10042_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416977791955217404)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416974913478217401)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P10042_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416978298198217404)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(3416974913478217401)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P10042_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416979757368217405)
,p_name=>'P10042_APPLICATION_ID'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_item_source_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_item_default=>'&APP_ID.'
,p_source=>'APPLICATION_ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_is_persistent=>'N'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416979290143217405)
,p_name=>'P10042_ID'
,p_source_data_type=>'NUMBER'
,p_is_primary_key=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_item_source_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_source=>'ID'
,p_display_as=>'NATIVE_HIDDEN'
,p_is_persistent=>'N'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416980751164217406)
,p_name=>'P10042_ROLE_IDS'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_item_source_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_prompt=>'Roles'
,p_source=>'ROLE_IDS'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'ACCESS_ROLES'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_lov_display_extra=>'NO'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>When Access Control is enabled, Administrators have the ability to restrict access to certain application features for authenticated users. This application supports the following 3 roles: Reader, Contributor, and Administrator.</p>',
'<ul>',
'  <li><strong>Readers</strong> have read-only access to all information and can also view reports.</li>',
'  <li><strong>Contributors</strong> can create,edit and delete information and view reports.</li>',
'  <li><strong>Administrators</strong>,in addition to Contributors capability,can also perform configuration of the application.</li>',
'</ul>'))
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_of_columns', '1')).to_clob
,p_multi_value_type=>'SEPARATED'
,p_multi_value_separator=>':'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416980209626217406)
,p_name=>'P10042_USER_NAME'
,p_source_data_type=>'VARCHAR2'
,p_is_required=>true
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_item_source_plug_id=>wwv_flow_imp.id(3416974884428217401)
,p_prompt=>'Username'
,p_source=>'USER_NAME'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_cSize=>60
,p_cMaxlength=>255
,p_read_only_when=>'P10042_ID'
,p_read_only_when_type=>'ITEM_IS_NOT_NULL'
,p_field_template=>1612549789555753698
,p_is_persistent=>'N'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'disabled', 'N',
  'submit_when_enter_pressed', 'N',
  'subtype', 'TEXT',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(3416983372568217410)
,p_validation_name=>'Cannot remove yourself from administrator'
,p_static_id=>'cannot-remove-yourself-from-administrator'
,p_validation_sequence=>10
,p_validation=>wwv_flow_string.join(wwv_flow_t_varchar2(
'if :P10042_USER_NAME = :APP_USER and',
'    apex_acl.is_role_removed_from_user (',
'        p_application_id => :APP_ID,',
'        p_user_name      => :APP_USER,',
'        p_role_static_id => ''ADMINISTRATOR'',',
'        p_role_ids       => apex_string.split_numbers(',
'                                p_str => case when :REQUEST = ''DELETE'' then',
'                                             null',
'                                         else',
'                                             :P10042_ROLE_IDS',
'                                         end,',
'                                p_sep => '':'') ) then',
'    return false;',
'else',
'    return true;',
'end if;'))
,p_validation2=>'PLSQL'
,p_validation_type=>'FUNC_BODY_RETURNING_BOOLEAN'
,p_error_message=>'You cannot remove administrator role from yourself.'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416984861118217412)
,p_process_sequence=>40
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416984861118217412
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416983890111217411)
,p_process_sequence=>10
,p_process_point=>'AFTER_HEADER'
,p_region_id=>wwv_flow_imp.id(3416974884428217401)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Manage User Access'
,p_static_id=>'initialize-form-manage-user-access'
,p_internal_uid=>3416983890111217411
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416984373402217411)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(3416974884428217401)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Manage User Access'
,p_static_id=>'process-form-manage-user-access'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'lock_row', 'N',
  'prevent_lost_updates', 'Y',
  'return_primary_keys_after_insert', 'N',
  'target_type', 'REGION_SOURCE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3416984373402217411
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10043
begin
wwv_flow_imp_page.create_page(
 p_id=>10043
,p_name=>'Add Multiple Users - Step 1'
,p_alias=>'ADD-MULTIPLE-USERS-STEP-1'
,p_page_mode=>'MODAL'
,p_step_title=>'Add Multiple Users'
,p_first_item=>'AUTO_FIRST_ITEM'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_deep_linking=>'N'
,p_page_component_map=>'16'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416985318510217412)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416985463188217412)
,p_plug_name=>'Wizard Container'
,p_static_id=>'wizard-container'
,p_region_template_options=>'#DEFAULT#:t-Form--stretchInputs'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416988265551217414)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416985318510217412)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3416988801125217415)
,p_button_id=>wwv_flow_imp.id(3416988265551217414)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416985531019217412)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416985318510217412)
,p_button_name=>'NEXT'
,p_static_id=>'next'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--iconRight'
,p_button_template_id=>2086257187394300437
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Next'
,p_button_position=>'NEXT'
,p_icon_css_classes=>'fa-chevron-right'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(3416989476854217415)
,p_branch_action=>'f?p=&APP_ID.:10044:&APP_SESSION.::&DEBUG.:RP,10044::&success_msg=#SUCCESS_MSG#'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_when_button_id=>wwv_flow_imp.id(3416985531019217412)
,p_branch_sequence=>10
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416990432640217416)
,p_name=>'P10043_PRELIM_USERS'
,p_is_required=>true
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416985463188217412)
,p_prompt=>'Usernames'
,p_placeholder=>'Enter usernames here'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_TEXTAREA'
,p_cSize=>80
,p_cMaxlength=>4000
,p_cHeight=>5
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_protection_level=>'I'
,p_inline_help_text=>'Enter usernames separated by commas, semicolons, or whitespace. Existing or duplicate usernames will automatically be ignored.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'auto_height', 'N',
  'character_counter', 'N',
  'resizable', 'Y',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416989903355217415)
,p_name=>'P10043_ROLE'
,p_is_required=>true
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416985463188217412)
,p_prompt=>'Roles'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'ACCESS_ROLES'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_of_columns', '3')).to_clob
,p_multi_value_type=>'SEPARATED'
,p_multi_value_separator=>':'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3416990922649217416)
,p_name=>'P10043_USERNAME_FORMAT'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3416985463188217412)
,p_prompt=>'Username Format'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_CHECKBOX'
,p_named_lov=>'EMAIL_USERNAME_FORMAT'
,p_field_template=>1612549789555753698
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_of_columns', '1')).to_clob
,p_multi_value_type=>'SEPARATED'
,p_multi_value_separator=>':'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3416992575031217418)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Create Collections'
,p_static_id=>'create-collections'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'declare',
'    l_line      varchar2(32767);',
'    l_emails    apex_t_varchar2;',
'    l_username  varchar2(4000);',
'    l_at        number;',
'    l_dot       number;',
'    l_valid     boolean := true;',
'    l_domain    varchar2(4000);',
'begin',
'    -- create collections',
'    apex_collection.create_or_truncate_collection(''ACL_BULK_USER_INVALID'');',
'    apex_collection.create_or_truncate_collection(''ACL_BULK_USER_VALID'');',
'',
'    -- replace delimiting characters with commas',
'    l_line := :P10043_PRELIM_USERS;',
'    l_line := replace(l_line, chr(10), '' '');',
'    l_line := replace(l_line, chr(13), '' '');',
'    l_line := replace(l_line, chr(9),  '' '');',
'    l_line := replace(l_line, ''<'', '' '');',
'    l_line := replace(l_line, ''>'', '' '');',
'    l_line := replace(l_line, '';'', '' '');',
'    l_line := replace(l_line, '':'', '' '');',
'    l_line := replace(l_line, ''('', '' '');',
'    l_line := replace(l_line, '')'', '' '');',
'    l_line := replace(l_line, '' '', '','');',
'',
'    -- get one comma separated line of emails',
'    for j in 1 .. 1000 loop',
'        if instr(l_line, '',,'') > 0 then',
'            l_line := replace(l_line, '',,'', '','');',
'        else',
'            exit;',
'        end if;',
'    end loop;',
'',
'    -- get an array of emails',
'    l_emails := apex_string.split(l_line, '','');',
'',
'    -- add emails to a collection',
'    l_username := null;',
'    l_domain   := null;',
'    l_at       := 0;',
'    l_dot      := 0;',
'    for j in 1..l_emails.count loop',
'        l_valid    := true;',
'        l_username := upper(trim(l_emails(j)));',
'        l_username := trim(both ''.'' from l_username);',
'        l_username := replace(l_username, '' '', null);',
'        l_username := replace(l_username, chr(10), null);',
'        l_username := replace(l_username, chr(9), null);',
'        l_username := replace(l_username, chr(13), null);',
'        l_username := replace(l_username, chr(49824), null);',
'',
'        if l_username is not null then',
'            if nvl(:P10043_USERNAME_FORMAT,''x'') = ''EMAIL'' then',
'              -- Validate',
'              l_at     := instr(nvl(l_username, ''x''), ''@'');',
'              l_domain := substr(l_username, l_at+1);',
'              l_dot    := instr(l_domain, ''.'');',
'              if l_at < 2 then',
'                  -- invalid email',
'                  apex_collection.add_member(',
'                      p_collection_name => ''ACL_BULK_USER_INVALID'',',
'                      p_c001            => l_username,',
'                      p_c002            => apex_lang.message(''APEX.FEATURE.ACL.BULK_USER.MISSING_AT_SIGN''));',
'                  commit;',
'                  l_valid := false;',
'              end if;',
'',
'              if l_dot = 0 and l_valid then',
'                  apex_collection.add_member(',
'                      p_collection_name => ''ACL_BULK_USER_INVALID'',',
'                      p_c001            => l_username,',
'                      p_c002            => apex_lang.message(''APEX.FEATURE.ACL.BULK_USER.MISSING_DOT''));',
'                  commit;',
'                  l_valid := false;',
'              end if;',
'            end if;',
'',
'            if l_valid and length(l_username) > 255 then',
'                apex_collection.add_member(',
'                    p_collection_name => ''ACL_BULK_USER_INVALID'',',
'                    p_c001            => l_username,',
'                    p_c002            => apex_lang.message(''APEX.FEATURE.ACL.BULK_USER.USERNAME_TOO_LONG''));',
'                commit;',
'                l_valid := false;',
'            end if;',
'',
'            if l_valid then',
'                for c1 in (select user_name username',
'                             from APEX_APPL_ACL_USERS',
'                            where user_name = l_username and application_id = :APP_ID)',
'                loop',
'                    apex_collection.add_member(',
'                        p_collection_name => ''ACL_BULK_USER_INVALID'',',
'                        p_c001            => l_username,',
'                        p_c002            => apex_lang.message(''APEX.FEATURE.ACL.BULK_USER.ALREADY_IN_ACL''));',
'                    commit;',
'                    l_valid := false;',
'                    exit;',
'                end loop;',
'            end if;',
'',
'            if l_valid then',
'                for c1 in (select c001',
'                             from apex_collections',
'                            where collection_name = ''ACL_BULK_USER_VALID''',
'                              and c001            = l_username)',
'                loop',
'                    apex_collection.add_member(',
'                        p_collection_name => ''ACL_BULK_USER_INVALID'',',
'                        p_c001            => l_username,',
'                        p_c002            => apex_lang.message(''APEX.FEATURE.ACL.BULK_USER.DUPLICATE_USER''));',
'                        commit;',
'                    l_valid := false;',
'                    exit;',
'                end loop;',
'            end if;',
'',
'            if l_valid then',
'                apex_collection.add_member(',
'                    p_collection_name => ''ACL_BULK_USER_VALID'',',
'                    p_c001            => l_username,',
'                    p_c002            => null,',
'                    p_c003            => :P10043_ROLE);',
'                    commit;',
'            end if;',
'',
'        end if;',
'        l_username := null;',
'    end loop;',
'end;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3416985531019217412)
,p_internal_uid=>3416992575031217418
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10044
begin
wwv_flow_imp_page.create_page(
 p_id=>10044
,p_name=>'Add Multiple Users - Step 2'
,p_alias=>'ADD-MULTIPLE-USERS-STEP-2'
,p_page_mode=>'MODAL'
,p_step_title=>'Add Multiple Users'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_inline_css=>wwv_flow_string.join(wwv_flow_t_varchar2(
'.a-ListView-item .fa {',
'  color: var(--ut-component-text-muted-color);',
'}',
'',
'.a-ListView-item .u-success-text {',
'  color: var(--ut-palette-success) !important;',
'}'))
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218790703210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_deep_linking=>'N'
,p_page_component_map=>'25'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416985683412217412)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_region(
 p_id=>wwv_flow_imp.id(3416985995906217412)
,p_name=>'Exceptions'
,p_static_id=>'exceptions'
,p_parent_plug_id=>wwv_flow_imp.id(3416985706774217412)
,p_template=>2667762537863948531
,p_display_sequence=>60
,p_region_template_options=>'#DEFAULT#:t-Region--noPadding:is-collapsed:t-Region--noUI:t-Region--scrollBody'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--staticRowColors:t-Report--rowHighlightOff'
,p_source_type=>'NATIVE_SQL_REPORT'
,p_query_type=>'SQL'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select c001 username, c002 reason',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_INVALID''',
'order by 1'))
,p_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_INVALID'''))
,p_display_condition_type=>'EXISTS'
,p_ajax_enabled=>'Y'
,p_lazy_loading=>false
,p_query_row_template=>2542081983073888486
,p_query_num_rows=>10000
,p_query_options=>'DERIVED_REPORT_COLUMNS'
,p_query_no_data_found=>'No data found.'
,p_query_num_rows_type=>'NEXT_PREVIOUS_LINKS'
,p_pagination_display_position=>'BOTTOM_RIGHT'
,p_csv_output=>'N'
,p_prn_output=>'N'
,p_sort_null=>'L'
,p_plug_query_strip_html=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416996992643217426)
,p_query_column_id=>2
,p_column_alias=>'REASON'
,p_column_display_sequence=>2
,p_column_heading=>'Reason'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_report_columns(
 p_id=>wwv_flow_imp.id(3416996212288217425)
,p_query_column_id=>1
,p_column_alias=>'USERNAME'
,p_column_display_sequence=>1
,p_column_heading=>'Username'
,p_heading_alignment=>'LEFT'
,p_derived_column=>'N'
,p_include_in_export=>'Y'
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416986113262217412)
,p_plug_name=>'Hidden Items'
,p_static_id=>'hidden-items'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417001071524217431)
,p_plug_name=>'No Valid Users Exist - Page Info'
,p_static_id=>'no-valid-users-exist-page-info'
,p_region_template_options=>'#DEFAULT#:margin-bottom-sm'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>'<p>No valid new users found</p>'
,p_plug_query_num_rows=>15
,p_plug_display_condition_type=>'NOT_EXISTS'
,p_plug_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416986002954217412)
,p_plug_name=>'&P10044_VALID_COUNT. Users to Add'
,p_static_id=>'p10044-valid-count-users-to-add'
,p_parent_plug_id=>wwv_flow_imp.id(3416985706774217412)
,p_region_template_options=>'#DEFAULT#'
,p_component_template_options=>'#DEFAULT#:t-Report--stretch:t-Report--staticRowColors:t-Report--rowHighlightOff'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>50
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select distinct c001 username',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID''',
'order by 1'))
,p_plug_source_type=>'NATIVE_JQM_LIST_VIEW'
,p_plug_query_num_rows=>10000
,p_plug_display_condition_type=>'EXISTS'
,p_plug_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'list_view_features', 'ADVANCED_FORMATTING',
  'text_formatting', '&USERNAME!HTML.')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417000069806217429)
,p_plug_name=>'Valid Users Exist - Page Info'
,p_static_id=>'valid-users-exist-page-info'
,p_region_template_options=>'#DEFAULT#:margin-bottom-sm'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_function_body_language=>'PLSQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'return ''<p>'' ||',
'       apex_lang.message (',
'           ''APEX.FEATURE.ACL.BULK_USER.CREATE_CONFIRM'',',
'           apex_escape.html(:P10044_VALID_COUNT),',
'           apex_escape.html(:P10044_ROLE)',
'       ) ||',
'       ''</p>'';'))
,p_plug_source_type=>'NATIVE_DYNAMIC_CONTENT'
,p_plug_query_num_rows=>15
,p_plug_display_condition_type=>'EXISTS'
,p_plug_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3416985706774217412)
,p_plug_name=>'Wizard Container'
,p_static_id=>'wizard-container'
,p_region_template_options=>'#DEFAULT#:t-Form--stretchInputs'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>40
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417002608816217432)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416985683412217412)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'PREVIOUS'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3417003380808217432)
,p_button_id=>wwv_flow_imp.id(3417002608816217432)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417002044601217432)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3416985683412217412)
,p_button_name=>'PREVIOUS'
,p_static_id=>'previous'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_URL'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>2352535364915922073
,p_button_image_alt=>'Previous'
,p_button_position=>'PREVIOUS'
,p_button_redirect_url=>'javascript:history.back();'
,p_icon_css_classes=>'fa-chevron-left'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3416986273063217412)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3416985683412217412)
,p_button_name=>'SUBMIT'
,p_static_id=>'submit'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Add Users'
,p_button_position=>'NEXT'
,p_button_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_button_condition_type=>'EXISTS'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417005091476217434)
,p_name=>'P10044_INVALID_COUNT'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3416986113262217412)
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select count(*)',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'I'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417003921434217433)
,p_name=>'P10044_ROLE'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3416986113262217412)
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select LISTAGG( role_name, '', '')',
'         WITHIN GROUP (ORDER BY role_name) role_name',
'from APEX_APPL_ACL_ROLES',
'where application_id = :APP_ID',
'and instr(:P10043_ROLE, role_id, 1) > 0'))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'I'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417004589153217433)
,p_name=>'P10044_VALID_COUNT'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3416986113262217412)
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select count(*)',
'  from apex_collections',
' where collection_name = ''ACL_BULK_USER_VALID'''))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'I'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417005502787217434)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Add Users to Access Control List'
,p_static_id=>'add-users-to-access-control-list'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'declare',
'    l_user_role_ids apex_application_global.vc_arr2;',
'begin',
'    for c in (  select distinct c001 as username, c003 as user_roles',
'                from   apex_collections',
'                where  collection_name = ''ACL_BULK_USER_VALID'' )',
'    loop',
'         l_user_role_ids := apex_util.string_to_table(c.user_roles);',
'         for i in 1..l_user_role_ids.count loop',
'             apex_acl.add_user_role(p_application_id => :APP_ID, p_user_name => c.username, p_role_id => l_user_role_ids(i));',
'         end loop;',
'    end loop;',
'',
'    apex_collection.delete_collection(''ACL_BULK_USER_INVALID'');',
'    apex_collection.delete_collection(''ACL_BULK_USER_VALID'');',
'    :P10043_PRELIM_USERS := null;',
'end;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3416986273063217412)
,p_process_success_message=>'User(s) added.'
,p_internal_uid=>3417005502787217434
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417006050697217435)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3417006050697217435
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10050
begin
wwv_flow_imp_page.create_page(
 p_id=>10050
,p_name=>'Feedback'
,p_alias=>'FEEDBACK'
,p_page_mode=>'MODAL'
,p_step_title=>'Feedback'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_inline_css=>wwv_flow_string.join(wwv_flow_t_varchar2(
'.feedback-positive, .feedback-negative, .feedback-neutral { padding: 8px; border-radius: 100%; background-color: white; margin: 4px; }',
'.feedback-positive { color: var(--ut-feedback-positive-text-color, var(--ut-palette-success)); }',
'.feedback-neutral { color: var(--ut-feedback-neutral-text-color, var(--ut-palette-warning)); }',
'.feedback-negative { color: var(--ut-feedback-negative-text-color, var(--ut-palette-danger)); }'))
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_dialog_width=>'480'
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'17'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417006674903217435)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417006543864217435)
,p_plug_name=>'Form on Feedback'
,p_static_id=>'form-on-feedback'
,p_region_template_options=>'#DEFAULT#:t-Form--stretchInputs'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417010270916217437)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3417006674903217435)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'EDIT'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3417010878156217437)
,p_button_id=>wwv_flow_imp.id(3417010270916217437)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417006720539217435)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3417006674903217435)
,p_button_name=>'SUBMIT'
,p_static_id=>'submit'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--gapLeft'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Submit Feedback'
,p_button_position=>'CREATE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(3417019608746217445)
,p_branch_action=>'f?p=&APP_ID.:10051:&APP_SESSION.::&DEBUG.:RP::'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>10
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417011432109217438)
,p_name=>'P10050_APPLICATION_ID'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3417006543864217435)
,p_use_cache_before_default=>'NO'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417015510379217442)
,p_name=>'P10050_FEEDBACK'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3417006543864217435)
,p_prompt=>'Feedback'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_TEXTAREA'
,p_cSize=>64
,p_cMaxlength=>4000
,p_cHeight=>4
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'auto_height', 'N',
  'character_counter', 'N',
  'resizable', 'Y',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417011987101217438)
,p_name=>'P10050_PAGE_ID'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3417006543864217435)
,p_use_cache_before_default=>'NO'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417012919990217439)
,p_name=>'P10050_RATING'
,p_item_sequence=>35
,p_item_plug_id=>wwv_flow_imp.id(3417006543864217435)
,p_prompt=>'Experience'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_RADIOGROUP'
,p_named_lov=>'FEEDBACK_RATING'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#:t-Form-fieldContainer--radioButtonGroup'
,p_lov_display_extra=>'NO'
,p_escape_on_http_output=>'N'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'number_of_columns', '3',
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417012456417217438)
,p_name=>'P10050_USER_AGENT'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3417006543864217435)
,p_use_cache_before_default=>'NO'
,p_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select sys.owa_util.get_cgi_env(''user-agent'') x',
'from sys.dual'))
,p_source_type=>'QUERY'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(3417019058684217444)
,p_validation_name=>'At least One Feedback Required'
,p_static_id=>'at-least-one-feedback-required'
,p_validation_sequence=>10
,p_validation=>wwv_flow_string.join(wwv_flow_t_varchar2(
'if :P10050_FEEDBACK is null and :P10050_RATING is null then',
'    return false;',
'else',
'    return true;',
'end if;'))
,p_validation2=>'PLSQL'
,p_validation_type=>'FUNC_BODY_RETURNING_BOOLEAN'
,p_error_message=>'Please provide feedback or your experience.'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417016165492217442)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Submit Feedback'
,p_static_id=>'submit-feedback'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'package', 'APEX_UTIL',
  'package_method', 'SUBMIT_FEEDBACK',
  'type', 'PLSQL_PACKAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3417006720539217435)
,p_process_success_message=>'Feedback Submitted'
,p_internal_uid=>3417016165492217442
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417017360685217443)
,p_page_process_id=>wwv_flow_imp.id(3417016165492217442)
,p_page_id=>10050
,p_name=>'p_application_id'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>true
,p_display_sequence=>2
,p_value_type=>'ITEM'
,p_value=>'APP_ID'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417016753356217443)
,p_page_process_id=>wwv_flow_imp.id(3417016165492217442)
,p_page_id=>10050
,p_name=>'p_comment'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>true
,p_display_sequence=>1
,p_value_type=>'ITEM'
,p_value=>'P10050_FEEDBACK'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417017973373217443)
,p_page_process_id=>wwv_flow_imp.id(3417016165492217442)
,p_page_id=>10050
,p_name=>'p_page_id'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>true
,p_display_sequence=>3
,p_value_type=>'ITEM'
,p_value=>'P10050_PAGE_ID'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417018575370217444)
,p_page_process_id=>wwv_flow_imp.id(3417016165492217442)
,p_page_id=>10050
,p_name=>'p_rating'
,p_direction=>'IN'
,p_data_type=>'NUMBER'
,p_has_default=>true
,p_display_sequence=>4
,p_value_type=>'ITEM'
,p_value=>'P10050_RATING'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10051
begin
wwv_flow_imp_page.create_page(
 p_id=>10051
,p_name=>'Feedback Submitted'
,p_alias=>'FEEDBACK-SUBMITTED'
,p_page_mode=>'MODAL'
,p_step_title=>'Feedback Submitted'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'11'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417007162496217435)
,p_plug_name=>'Feedback Submitted'
,p_static_id=>'feedback-submitted'
,p_icon_css_classes=>'fa-check-circle'
,p_region_template_options=>'#DEFAULT#:t-Alert--wizard:t-Alert--customIcons:t-Alert--success'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2044111091335791563
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417007054382217435)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3417007162496217435)
,p_button_name=>'CLOSE'
,p_static_id=>'close'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Close'
,p_button_position=>'CLOSE'
,p_warn_on_unsaved_changes=>null
,p_button_css_classes=>'w40p'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3417021369623217446)
,p_button_id=>wwv_flow_imp.id(3417007054382217435)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10053
begin
wwv_flow_imp_page.create_page(
 p_id=>10053
,p_name=>'Manage Feedback'
,p_alias=>'MANAGE-FEEDBACK'
,p_page_mode=>'MODAL'
,p_step_title=>'Manage Feedback'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_inline_css=>wwv_flow_string.join(wwv_flow_t_varchar2(
'/* Color feedback rating icons */',
'.feedback-positive { color: var(--ut-feedback-positive-text-color, var(--ut-palette-success)); }',
'.feedback-neutral { color: var(--ut-feedback-neutral-text-color, var(--ut-palette-warning)); }',
'.feedback-negative { color: var(--ut-feedback-negative-text-color, var(--ut-palette-danger)); }'))
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#:ui-dialog--stretch:t-Dialog--noPadding'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_help_text=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Feedback can be entered by end users from any normal page within the application.</p>',
'<p>This report shows the feedback entered, any response enter by administrators, and the status of the feedback.</p>',
'<p>Click the edit icon (yellow pencil) to enter a response or update the feedback status.</p>',
'<p><em><strong>Note:</strong> If feedback recipients have been defined then feedback submissions will also be emailed to the email addresses in the feedback recipients list.</em></p>'))
,p_page_component_map=>'18'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417008474983217435)
,p_plug_name=>'Manage Feedback'
,p_static_id=>'manage-feedback'
,p_region_template_options=>'#DEFAULT#:t-IRR-region--noBorders'
,p_plug_template=>2103954283454391425
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select feedback_id id,',
'    page_id||''. ''||page_name page_name,',
'    created_on created,',
'    lower(created_by) created_by,',
'    feedback,',
'    feedback_rating rating,',
'    case feedback_rating',
'      when 1 then ''fa-frown-o feedback-negative'' ',
'      when 2 then ''fa-emoji-neutral feedback-neutral''  ',
'      when 3 then ''fa-smile-o feedback-positive''',
'    end rating_icon,',
'    feedback_status status,',
'    public_response response,',
'    http_user_agent user_agent,',
'    updated_on updated,',
'    lower(updated_by) updated_by,',
'    page_id',
'from apex_team_feedback f',
'where application_id = :APP_ID'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_content_disposition=>'ATTACHMENT'
,p_prn_units=>'INCHES'
,p_prn_paper_size=>'LETTER'
,p_prn_width=>11
,p_prn_height=>8.5
,p_prn_orientation=>'HORIZONTAL'
,p_prn_page_header_font_color=>'#000000'
,p_prn_page_header_font_family=>'Helvetica'
,p_prn_page_header_font_weight=>'normal'
,p_prn_page_header_font_size=>'12'
,p_prn_page_footer_font_color=>'#000000'
,p_prn_page_footer_font_family=>'Helvetica'
,p_prn_page_footer_font_weight=>'normal'
,p_prn_page_footer_font_size=>'12'
,p_prn_header_bg_color=>'#EEEEEE'
,p_prn_header_font_color=>'#000000'
,p_prn_header_font_family=>'Helvetica'
,p_prn_header_font_weight=>'bold'
,p_prn_header_font_size=>'10'
,p_prn_body_bg_color=>'#FFFFFF'
,p_prn_body_font_color=>'#000000'
,p_prn_body_font_family=>'Helvetica'
,p_prn_body_font_weight=>'normal'
,p_prn_body_font_size=>'10'
,p_prn_border_width=>.5
,p_prn_page_header_alignment=>'CENTER'
,p_prn_page_footer_alignment=>'CENTER'
,p_prn_border_color=>'#666666'
,p_ai_enabled=>false
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(3417037416566217459)
,p_max_row_count_message=>'The maximum row count for this report is #MAX_ROW_COUNT# rows.  Please apply a filter to reduce the number of records in your query.'
,p_no_data_found_message=>'No data found.'
,p_pagination_type=>'ROWS_X_TO_Y'
,p_pagination_display_pos=>'BOTTOM_RIGHT'
,p_report_list_mode=>'TABS'
,p_lazy_loading=>false
,p_show_detail_link=>'C'
,p_show_notify=>'Y'
,p_download_formats=>'CSV:HTML:XLSX:PDF'
,p_enable_mail_download=>'Y'
,p_detail_link=>'f?p=&APP_ID.:10054:&APP_SESSION.::&DEBUG.:RP:P10054_ID:\#ID#\'
,p_detail_link_text=>'<span role="img" aria-label="Edit" class="fa fa-edit" title="Edit"></span>'
,p_internal_uid=>3417037416566217459
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417041980181217468)
,p_db_column_name=>'CREATED'
,p_display_order=>3
,p_column_identifier=>'C'
,p_column_label=>'Filed'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'SINCE'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417042637352217470)
,p_db_column_name=>'CREATED_BY'
,p_display_order=>4
,p_column_identifier=>'D'
,p_column_label=>'Filed By'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417043306754217471)
,p_db_column_name=>'FEEDBACK'
,p_display_order=>5
,p_column_identifier=>'E'
,p_column_label=>'Feedback'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417040212072217465)
,p_db_column_name=>'ID'
,p_display_order=>0
,p_is_primary_key=>'Y'
,p_column_identifier=>'A'
,p_column_label=>'ID'
,p_column_type=>'NUMBER'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417049520348217482)
,p_db_column_name=>'PAGE_ID'
,p_display_order=>13
,p_column_identifier=>'M'
,p_column_label=>'Page'
,p_column_type=>'NUMBER'
,p_heading_alignment=>'RIGHT'
,p_column_alignment=>'RIGHT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417041117482217467)
,p_db_column_name=>'PAGE_NAME'
,p_display_order=>2
,p_column_identifier=>'B'
,p_column_label=>'Page'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417044365021217472)
,p_db_column_name=>'RATING'
,p_display_order=>6
,p_column_identifier=>'F'
,p_column_label=>'Rating'
,p_column_html_expression=>'<span class="fa #RATING_ICON#" aria-hidden="true" title="#RATING#"></span>'
,p_column_type=>'NUMBER'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_column_alignment=>'CENTER'
,p_rpt_named_lov=>wwv_flow_imp.id(3417013025855217439)
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417045078785217474)
,p_db_column_name=>'RATING_ICON'
,p_display_order=>7
,p_column_identifier=>'G'
,p_column_label=>'RATING ICON'
,p_column_type=>'STRING'
,p_display_text_as=>'HIDDEN_ESCAPE_SC'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417046488940217476)
,p_db_column_name=>'RESPONSE'
,p_display_order=>9
,p_column_identifier=>'I'
,p_column_label=>'Response'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417045756312217475)
,p_db_column_name=>'STATUS'
,p_display_order=>8
,p_column_identifier=>'H'
,p_column_label=>'Status'
,p_column_type=>'NUMBER'
,p_display_text_as=>'LOV_ESCAPE_SC'
,p_heading_alignment=>'LEFT'
,p_rpt_named_lov=>wwv_flow_imp.id(3417028449948217452)
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417048041404217479)
,p_db_column_name=>'UPDATED'
,p_display_order=>11
,p_column_identifier=>'K'
,p_column_label=>'Updated'
,p_column_type=>'DATE'
,p_heading_alignment=>'LEFT'
,p_format_mask=>'SINCE'
,p_tz_dependent=>'N'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417048857704217480)
,p_db_column_name=>'UPDATED_BY'
,p_display_order=>12
,p_column_identifier=>'L'
,p_column_label=>'Updated By'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(3417047274491217478)
,p_db_column_name=>'USER_AGENT'
,p_display_order=>10
,p_column_identifier=>'J'
,p_column_label=>'User Agent'
,p_column_type=>'STRING'
,p_heading_alignment=>'LEFT'
,p_use_as_row_header=>'N'
,p_available_clientside=>'N'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_worksheet_rpt(
 p_id=>wwv_flow_imp.id(3417055616131217488)
,p_application_user=>'APXWS_DEFAULT'
,p_report_seq=>10
,p_report_alias=>'primary'
,p_status=>'PUBLIC'
,p_is_default=>'Y'
,p_report_columns=>'PAGE_NAME:CREATED:CREATED_BY:FEEDBACK:RATING:STATUS:RESPONSE:UPDATED:UPDATED_BY'
,p_sort_column_1=>'UPDATED'
,p_sort_direction_1=>'DESC'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3417008341279217435)
,p_name=>'Refresh Report'
,p_static_id=>'refresh-report'
,p_event_sequence=>10
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(3417008474983217435)
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'apexafterclosedialog'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3417056832462217489)
,p_event_id=>wwv_flow_imp.id(3417008341279217435)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_static_id=>'native-refresh'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(3417008474983217435)
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'maintain_pagination', 'N')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10054
begin
wwv_flow_imp_page.create_page(
 p_id=>10054
,p_name=>'Feedback'
,p_alias=>'FEEDBACK1'
,p_page_mode=>'MODAL'
,p_step_title=>'Feedback'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_inline_css=>wwv_flow_string.join(wwv_flow_t_varchar2(
'/* Color feedback rating icons */',
'.feedback-positive { color: var(--ut-feedback-positive-text-color, var(--ut-palette-success)); }',
'.feedback-neutral { color: var(--ut-feedback-neutral-text-color, var(--ut-palette-warning)); }',
'.feedback-negative { color: var(--ut-feedback-negative-text-color, var(--ut-palette-danger)); }'))
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(3415221434058210839)
,p_required_patch=>wwv_flow_imp.id(3415218930059210834)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'17'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417007871136217435)
,p_plug_name=>'Buttons'
,p_static_id=>'buttons'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2129856781885180476
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_03'
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417007703825217435)
,p_plug_name=>'Form Items Region'
,p_static_id=>'form-items-region'
,p_region_template_options=>'#DEFAULT#:t-Form--stretchInputs'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417023626125217448)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3417007871136217435)
,p_button_name=>'CANCEL'
,p_static_id=>'cancel'
,p_show_as_disabled=>false
,p_button_action=>'DEFINED_BY_DA_ACTION'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Cancel'
,p_button_position=>'EDIT'
,p_button_execute_validations=>'N'
,p_warn_on_unsaved_changes=>null
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_component_da_action(
 p_id=>wwv_flow_imp.id(3417024251453217449)
,p_button_id=>wwv_flow_imp.id(3417023626125217448)
,p_action_sequence=>10
,p_action=>'NATIVE_DIALOG_CANCEL'
,p_static_id=>'native-dialog-cancel'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417008145967217435)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(3417007871136217435)
,p_button_name=>'DELETE'
,p_static_id=>'delete'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--danger:t-Button--simple'
,p_button_template_id=>4075790603270660137
,p_button_image_alt=>'Delete'
,p_button_position=>'EDIT'
,p_button_execute_validations=>'N'
,p_confirm_message=>'&APP_TEXT$DELETE_MSG!RAW.'
,p_confirm_style=>'danger'
,p_button_condition=>'P10054_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417007927274217435)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(3417007871136217435)
,p_button_name=>'SAVE'
,p_static_id=>'save'
,p_show_as_disabled=>false
,p_button_action=>'SUBMIT'
,p_button_template_options=>'#DEFAULT#:t-Button--gapLeft'
,p_button_template_id=>4075790603270660137
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'CREATE'
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417027208986217451)
,p_name=>'P10054_FEEDBACK'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Feedback'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417028369586217452)
,p_name=>'P10054_FEEDBACK_STATUS'
,p_item_sequence=>70
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Status'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'FEEDBACK_STATUS'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'page_action_on_selection', 'NONE')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417026113936217450)
,p_name=>'P10054_FILED'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Filed'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_begin_on_new_line=>'N'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417025257845217449)
,p_name=>'P10054_ID'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417025786427217450)
,p_name=>'P10054_PAGE_ID'
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Page'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417026765540217451)
,p_name=>'P10054_RATING_ICON'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Rating'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_begin_on_new_line=>'N'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'format', 'HTML',
  'send_on_page_submit', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417027756069217452)
,p_name=>'P10054_RESPONSE'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'Response'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_TEXTAREA'
,p_cSize=>64
,p_cMaxlength=>4000
,p_cHeight=>4
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'auto_height', 'N',
  'character_counter', 'N',
  'resizable', 'Y',
  'trim_spaces', 'BOTH')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071412Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071412Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417031413058217455)
,p_name=>'P10054_USER_AGENT'
,p_item_sequence=>100
,p_item_plug_id=>wwv_flow_imp.id(3417007703825217435)
,p_prompt=>'User Agent'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_DISPLAY_ONLY'
,p_field_template=>1612549609962752680
,p_lov_display_extra=>'NO'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'based_on', 'VALUE',
  'format', 'PLAIN',
  'send_on_page_submit', 'Y',
  'show_line_breaks', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417035806144217458)
,p_process_sequence=>40
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_SESSION_STATE'
,p_process_name=>'Clear Page(s) Cache'
,p_static_id=>'clear-page-s-cache'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'type', 'CLEAR_CACHE_CURRENT_PAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3417008145967217435)
,p_internal_uid=>3417035806144217458
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417036326064217459)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_static_id=>'close-dialog'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_internal_uid=>3417036326064217459
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417034742986217458)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Delete Feedback'
,p_static_id=>'delete-feedback'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'package', 'APEX_UTIL',
  'package_method', 'DELETE_FEEDBACK',
  'type', 'PLSQL_PACKAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3417008145967217435)
,p_process_success_message=>'Feedback Deleted'
,p_internal_uid=>3417034742986217458
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417035338119217458)
,p_page_process_id=>wwv_flow_imp.id(3417034742986217458)
,p_page_id=>10054
,p_name=>'p_feedback_id'
,p_direction=>'IN'
,p_data_type=>'NUMBER'
,p_has_default=>false
,p_display_sequence=>1
,p_value_type=>'ITEM'
,p_value=>'P10054_ID'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417032015568217456)
,p_process_sequence=>10
,p_process_point=>'AFTER_HEADER'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Load Data'
,p_static_id=>'load-data'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'for l_feedback in (',
'   select page_id,',
'          page_name,',
'          case feedback_rating',
'                when 1 then ''<span class="fa fa-frown-o feedback-negative" aria-hidden="true" title="Negative"></span>'' ',
'                when 2 then ''<span class="fa fa-emoji-neutral feedback-neutral" aria-hidden="true" title="Neutral"></span>''  ',
'                when 3 then ''<span class="fa fa-smile-o feedback-positive" aria-hidden="true" title="Positive"></span>'' ',
'                end rating_icon,',
'          lower(created_by) || '' - '' || apex_util.get_since(created_on) filed,',
'          feedback,',
'          public_response,',
'          feedback_status,',
'          http_user_agent',
'     from apex_team_feedback',
'    where feedback_id = :P10054_ID )',
'loop',
'   :P10054_PAGE_ID         := l_feedback.page_id||''. ''||l_feedback.page_name;',
'   :P10054_FILED           := l_feedback.filed;',
'   :P10054_RATING_ICON     := l_feedback.rating_icon;',
'   :P10054_FEEDBACK        := l_feedback.feedback;',
'   :P10054_RESPONSE        := l_feedback.public_response;',
'   :P10054_FEEDBACK_STATUS := l_feedback.feedback_status;',
'   :P10054_USER_AGENT      := l_feedback.http_user_agent;',
'end loop;'))
,p_process_clob_language=>'PLSQL'
,p_internal_uid=>3417032015568217456
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(3417032418918217456)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Reply to Feedback'
,p_static_id=>'reply-to-feedback'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'package', 'APEX_UTIL',
  'package_method', 'REPLY_TO_FEEDBACK',
  'type', 'PLSQL_PACKAGE')).to_clob
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when_button_id=>wwv_flow_imp.id(3417007927274217435)
,p_process_success_message=>'Action Processed.'
,p_internal_uid=>3417032418918217456
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417033172272217457)
,p_page_process_id=>wwv_flow_imp.id(3417032418918217456)
,p_page_id=>10054
,p_name=>'p_feedback_id'
,p_direction=>'IN'
,p_data_type=>'NUMBER'
,p_has_default=>false
,p_display_sequence=>1
,p_value_type=>'ITEM'
,p_value=>'P10054_ID'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417034387005217457)
,p_page_process_id=>wwv_flow_imp.id(3417032418918217456)
,p_page_id=>10054
,p_name=>'p_public_response'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_has_default=>true
,p_display_sequence=>3
,p_value_type=>'ITEM'
,p_value=>'P10054_RESPONSE'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_shared.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(3417033702054217457)
,p_page_process_id=>wwv_flow_imp.id(3417032418918217456)
,p_page_id=>10054
,p_name=>'p_status'
,p_direction=>'IN'
,p_data_type=>'NUMBER'
,p_has_default=>true
,p_display_sequence=>2
,p_value_type=>'ITEM'
,p_value=>'P10054_FEEDBACK_STATUS'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10060
begin
wwv_flow_imp_page.create_page(
 p_id=>10060
,p_name=>'About'
,p_alias=>'ABOUT'
,p_step_title=>'About'
,p_warn_on_unsaved_changes=>'N'
,p_first_item=>'AUTO_FIRST_ITEM'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3415223083430210842)
,p_step_template=>4075783602716660119
,p_page_template_options=>'#DEFAULT#'
,p_required_patch=>wwv_flow_imp.id(3415219407143210834)
,p_protection_level=>'C'
,p_help_text=>'All application help text can be accessed from this page. The links in the "Documentation" region give a much more in-depth explanation of the application''s features and functionality.'
,p_page_component_map=>'11'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417058339492217490)
,p_plug_name=>'About Page'
,p_static_id=>'about-page'
,p_region_template_options=>'#DEFAULT#:t-ContentBlock--padded:t-ContentBlock--h1:t-ContentBlock--lightBG'
,p_escape_on_http_output=>'Y'
,p_plug_template=>2325543309974442989
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'SQL'
,p_plug_source=>'This application was generated directly from Sample Datasets. Go to SQL Workshop, Utilities, Sample Datasets to install tables and then create an application based on those tables.'
,p_plug_query_num_rows=>15
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_10061
begin
wwv_flow_imp_page.create_page(
 p_id=>10061
,p_name=>'Help'
,p_alias=>'HELP'
,p_page_mode=>'MODAL'
,p_step_title=>'Help'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_step_template=>2103835248774687739
,p_page_template_options=>'#DEFAULT#'
,p_required_patch=>wwv_flow_imp.id(3415219407143210834)
,p_dialog_chained=>'N'
,p_dialog_resizable=>'Y'
,p_protection_level=>'C'
,p_page_component_map=>'25'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417059379199217491)
,p_plug_name=>'Search Dialog'
,p_static_id=>'search-dialog'
,p_region_template_options=>'#DEFAULT#'
,p_escape_on_http_output=>'Y'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_function_body_language=>'PLSQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'for l_page in ( select page_title,',
'                       help_text',
'                  from apex_application_pages',
'                 where application_id = :APP_ID',
'                   and page_id = :P10061_PAGE_ID )',
'loop',
'    if l_page.help_text is null then',
'        return ''No help is available for this page.'';',
'    else',
'        return case when substr(l_page.help_text, 1, 3) != ''<p>'' then ''<p>'' end ||',
'               apex_application.do_substitutions(l_page.help_text) ||',
'               case when substr(trim(l_page.help_text), -4) != ''</p>'' then ''</p>'' end;',
'    end if;',
'end loop;'))
,p_plug_source_type=>'NATIVE_DYNAMIC_CONTENT'
,p_plug_query_num_rows=>15
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417059895229217492)
,p_name=>'P10061_PAGE_ID'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3417059379199217491)
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_HIDDEN'
,p_lov_display_extra=>'NO'
,p_protection_level=>'S'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'value_protected', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_20000
begin
wwv_flow_imp_page.create_page(
 p_id=>20000
,p_name=>'Settings'
,p_alias=>'SETTINGS'
,p_page_mode=>'MODAL'
,p_step_title=>'Settings'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3417097778037217536)
,p_step_template=>1664614232864994871
,p_page_template_options=>'#DEFAULT#:t-Dialog--noPadding:js-dialog-class-t-Drawer--pullOutEnd:js-dialog-class-t-Drawer--md'
,p_required_patch=>wwv_flow_imp.id(3417098503295217537)
,p_protection_level=>'C'
,p_help_text=>'This page contains a list of settings applicable to the current application user.'
,p_page_component_map=>'23'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417105230347217544)
,p_plug_name=>'&APP_USER.'
,p_static_id=>'app-user'
,p_region_template_options=>'#DEFAULT#:t-HeroRegion--hideIcon'
,p_plug_template=>2677445476673898083
,p_plug_display_sequence=>10
,p_plug_item_display_point=>'ABOVE'
,p_plug_display_condition_type=>'NOT_EXISTS'
,p_plug_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from apex_application_auth ',
' where application_id            = :APP_ID ',
'   and is_current_authentication = ''Y'' ',
'   and scheme_type_code          = ''NATIVE_APEX_ACCOUNTS'''))
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417105974881217545)
,p_plug_name=>'&APP_USER.'
,p_static_id=>'app-user-2'
,p_region_template_options=>'#DEFAULT#:t-CardsRegion--styleB'
,p_plug_template=>2076152157930740558
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'ABOVE'
,p_query_type=>'TABLE'
,p_query_table=>'APEX_WORKSPACE_APEX_USERS'
,p_query_where=>'user_name = :APP_USER and workspace_id = :WORKSPACE_ID'
,p_include_rowid_column=>false
,p_lazy_loading=>false
,p_plug_source_type=>'NATIVE_CARDS'
,p_plug_query_num_rows_type=>'SCROLL'
,p_show_total_row_count=>false
,p_plug_display_condition_type=>'EXISTS'
,p_plug_display_when_condition=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1 ',
'  from apex_application_auth ',
' where application_id            = :APP_ID ',
'   and is_current_authentication = ''Y'' ',
'   and scheme_type_code          = ''NATIVE_APEX_ACCOUNTS'''))
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_card(
 p_id=>wwv_flow_imp.id(3417106516263217546)
,p_region_id=>wwv_flow_imp.id(3417105974881217545)
,p_layout_type=>'ROW'
,p_card_css_classes=>'a-CardView--noUI'
,p_title_adv_formatting=>false
,p_title_column_name=>'USER_NAME'
,p_sub_title_adv_formatting=>false
,p_sub_title_column_name=>'EMAIL'
,p_body_adv_formatting=>false
,p_second_body_adv_formatting=>false
,p_icon_source_type=>'INITIALS'
,p_icon_class_column_name=>'EMAIL'
,p_icon_position=>'START'
,p_media_adv_formatting=>false
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417107298134217546)
,p_plug_name=>'Settings'
,p_static_id=>'settings'
,p_region_template_options=>'#DEFAULT#'
,p_component_template_options=>'#DEFAULT#:t-MediaList--showBadges:u-colors'
,p_plug_template=>4504868307683981366
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'ABOVE'
,p_list_id=>wwv_flow_imp.id(3417103531458217542)
,p_plug_source_type=>'NATIVE_LIST'
,p_list_template_id=>2071422514019082236
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/pages/page_20010
begin
wwv_flow_imp_page.create_page(
 p_id=>20010
,p_name=>'Push Notifications'
,p_alias=>'PUSH-NOTIFICATIONS'
,p_page_mode=>'MODAL'
,p_step_title=>'Settings - Push Notifications'
,p_warn_on_unsaved_changes=>'N'
,p_autocomplete_on_off=>'OFF'
,p_group_id=>wwv_flow_imp.id(3417097778037217536)
,p_javascript_code_onload=>'apex.pwa.initPushSubscriptionPage();'
,p_step_template=>1664614232864994871
,p_page_template_options=>'#DEFAULT#:js-dialog-class-t-Drawer--pullOutEnd'
,p_required_patch=>wwv_flow_imp.id(3417098023305217537)
,p_protection_level=>'C'
,p_help_text=>'This page contains the settings for controlling push notification subscription for the current user.'
,p_page_component_map=>'17'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_last_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_last_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417100482154217539)
,p_plug_name=>'Push Notifications'
,p_static_id=>'push-notifications'
,p_region_css_classes=>'a-pwaPush--subscriptionRegion'
,p_icon_css_classes=>'fa-bell-o'
,p_region_template_options=>'#DEFAULT#:t-Alert--colorBG:t-Alert--wizard:t-Alert--customIcons:t-Alert--info:t-Alert--removeHeading js-removeLandmark:t-Form--xlarge'
,p_plug_template=>2044111091335791563
,p_plug_display_sequence=>30
,p_plug_item_display_point=>'BELOW'
,p_plug_source=>'Push notifications have to be enabled for each device you want to receive the notifications on. The first time you enable push notifications, you will have to grant permission to your browser. This setting can be changed at any time.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(3417099835810217539)
,p_plug_name=>'Push Notifications Not Supported'
,p_static_id=>'push-notifications-not-supported'
,p_region_css_classes=>'a-pwaPush--subscriptionRegion--not-supported u-DisplayNone'
,p_icon_css_classes=>'fa-bell-slash-o'
,p_region_template_options=>'#DEFAULT#:t-Alert--colorBG:t-Alert--wizard:t-Alert--customIcons:t-Alert--warning:t-Alert--removeHeading js-removeLandmark:t-Form--xlarge'
,p_plug_template=>2044111091335791563
,p_plug_display_sequence=>20
,p_plug_item_display_point=>'BELOW'
,p_plug_source=>'Push notifications are not currently supported in your browser.'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'expand_shortcuts', 'N',
  'output_as', 'HTML')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(3417099304730217538)
,p_button_sequence=>10
,p_button_name=>'BACK'
,p_static_id=>'back'
,p_show_as_disabled=>false
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#:t-Button--link:t-Button--iconLeft'
,p_button_template_id=>2086257187394300437
,p_button_image_alt=>'Settings'
,p_button_redirect_url=>'f?p=&APP_ID.:20000:&APP_SESSION.::&DEBUG.:::'
,p_button_css_classes=>'t-Button--inlineLink'
,p_icon_css_classes=>'fa-chevron-left'
,p_grid_new_row=>'Y'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(3417101142710217540)
,p_name=>'P20010_ENABLE_PUSH'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(3417100482154217539)
,p_prompt=>'Enable push notifications on this device'
,p_source_type=>'ALWAYS_NULL'
,p_display_as=>'NATIVE_SINGLE_CHECKBOX'
,p_field_template=>1612549609962752680
,p_item_template_options=>'#DEFAULT#:margin-top-sm'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'use_defaults', 'Y')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(3417101691277217540)
,p_name=>'Change P20010_ENABLE_PUSH'
,p_static_id=>'change-p20010-enable-push'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P20010_ENABLE_PUSH'
,p_condition_element=>'P20010_ENABLE_PUSH'
,p_triggering_condition_type=>'EQUALS'
,p_triggering_expression=>'Y'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3417102246896217541)
,p_event_id=>wwv_flow_imp.id(3417101691277217540)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_name=>'Subscribe to push notifications'
,p_static_id=>'subscribe-to-push-notifications'
,p_action=>'NATIVE_JAVASCRIPT_CODE'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'js_code', 'apex.pwa.subscribePushNotifications();')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(3417102985431217541)
,p_event_id=>wwv_flow_imp.id(3417101691277217540)
,p_event_result=>'FALSE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_name=>'Unsubscribe from push notifications'
,p_static_id=>'unsubscribe-from-push-notifications'
,p_action=>'NATIVE_JAVASCRIPT_CODE'
,p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(
  'js_code', 'apex.pwa.unsubscribePushNotifications();')).to_clob
,p_created_on=>wwv_flow_imp.dz('20261014071413Z')
,p_updated_on=>wwv_flow_imp.dz('20261014071413Z')
,p_created_by=>'DEVELOPER'
,p_updated_by=>'DEVELOPER'
);
end;
/
prompt --application/deployment/definition
begin
null;
end;
/
prompt --application/deployment/checks
begin
null;
end;
/
prompt --application/deployment/buildoptions
begin
null;
end;
/
prompt --application/end_environment
begin
wwv_flow_imp.import_end(p_auto_install_sup_obj => nvl(wwv_flow_application_install.get_auto_install_sup_obj, false)
);
commit;
end;
/
set verify on feedback on define on
prompt  ...done
