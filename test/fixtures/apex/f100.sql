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
-- (a hand-written test fixture for pgkiln's APEX importer, sprint 182)
--------------------------------------------------------------------------------
begin
wwv_flow_imp.import_begin (
 p_version_yyyy_mm_dd=>'2023.10.31'
,p_release=>'23.2.0'
,p_default_workspace_id=>13690105424197432
,p_default_application_id=>100
,p_default_id_offset=>0
,p_default_owner=>'SALES'
);
end;
/
 
prompt APPLICATION 100 - Order's Desk
--
-- Application Export:
--   Application:     100
--   Name:            Order's Desk
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
,p_owner=>nvl(wwv_flow_application_install.get_schema,'SALES')
,p_name=>nvl(wwv_flow_application_install.get_application_name,'Order''s Desk')
,p_alias=>nvl(wwv_flow_application_install.get_application_alias,'ORDERS-DESK')
,p_page_view_logging=>'YES'
,p_page_protection_enabled_y_n=>'Y'
,p_checksum_salt=>'0F3A1B2C'
,p_bookmark_checksum_function=>'SH512'
,p_compatibility_mode=>'21.2'
,p_flow_language=>'en'
,p_flow_language_derived_from=>'FLOW_PRIMARY_LANGUAGE'
,p_date_format=>'DD-MON-YYYY'
,p_authentication_id=>wwv_flow_imp.id(13700000000000001)
,p_application_tab_set=>1
,p_logo_type=>'T'
,p_logo_text=>'Order''s Desk'
,p_flow_version=>'Release 1.0'
,p_flow_status=>'AVAILABLE_W_EDIT_LINK'
,p_flow_unavailable_text=>'This application is currently unavailable at this time.'
,p_exact_substitutions_only=>'Y'
,p_browser_cache=>'N'
,p_browser_frame=>'D'
,p_runtime_api_usage=>'T'
,p_pass_ecid=>'N'
,p_file_prefix=>nvl(wwv_flow_application_install.get_static_app_file_prefix,'')
,p_files_version=>2
,p_version_scn=>41228906654321
,p_print_server_type=>'INSTANCE'
,p_file_storage=>'DB'
,p_is_pwa=>'N'
);
end;
/
prompt --application/user_interfaces
begin
wwv_flow_imp_shared.create_user_interface(
 p_id=>wwv_flow_imp.id(13700000000000002)
,p_theme_id=>42
,p_home_url=>'f?p=&APP_ID.:1:&SESSION.'
,p_login_url=>'f?p=&APP_ID.:LOGIN:&APP_SESSION.::&DEBUG.:::'
,p_theme_style_by_user_pref=>false
,p_built_with_love=>false
,p_global_page_id=>0
,p_navigation_list_id=>wwv_flow_imp.id(13700000000000010)
,p_navigation_list_position=>'SIDE'
,p_navigation_list_template_id=>wwv_flow_imp.id(13700000000000099)
,p_nav_list_template_options=>'#DEFAULT#:t-TreeNav--styleA:js-navCollapsed--hidden'
);
end;
/
prompt --application/shared_components/navigation/lists/navigation_menu
begin
wwv_flow_imp_shared.create_list(
 p_id=>wwv_flow_imp.id(13700000000000010)
,p_name=>'Navigation Menu'
,p_list_status=>'PUBLIC'
,p_version_scn=>41228906654321
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(13700000000000011)
,p_list_item_display_sequence=>10
,p_list_item_link_text=>'Home'
,p_list_item_link_target=>'f?p=&APP_ID.:1:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-home'
,p_list_item_current_type=>'TARGET_PAGE'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(13700000000000012)
,p_list_item_display_sequence=>20
,p_list_item_link_text=>'Orders'
,p_list_item_link_target=>'f?p=&APP_ID.:2:&APP_SESSION.::&DEBUG.:::'
,p_list_item_icon=>'fa-table'
,p_list_item_current_type=>'COLON_DELIMITED_PAGE_LIST'
,p_list_item_current_for_pages=>'2,3'
);
wwv_flow_imp_shared.create_list_item(
 p_id=>wwv_flow_imp.id(13700000000000013)
,p_list_item_display_sequence=>30
,p_list_item_link_text=>'Oracle'
,p_list_item_link_target=>'https://www.oracle.com'
,p_parent_list_item_id=>wwv_flow_imp.id(13700000000000012)
,p_security_scheme=>wwv_flow_imp.id(13700000000000020)
);
end;
/
prompt --application/shared_components/security/authorizations/administration_rights
begin
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(13700000000000020)
,p_name=>'Administration Rights'
,p_scheme_type=>'NATIVE_EXISTS'
,p_attribute_01=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from sales.staff',
' where upper(username) = upper(:APP_USER)',
'   and is_admin = ''Y'''))
,p_error_message=>'Insufficient privileges, user is not an Administrator'
,p_version_scn=>41228906654321
,p_caching=>'BY_USER_BY_PAGE_VIEW'
);
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(13700000000000021)
,p_name=>'Contributors'
,p_scheme_type=>'NATIVE_IS_IN_GROUP'
,p_attribute_01=>'CONTRIBUTOR'
,p_attribute_02=>'A'
,p_error_message=>'You are not a contributor.'
,p_caching=>'BY_USER_BY_SESSION'
);
wwv_flow_imp_shared.create_security_scheme(
 p_id=>wwv_flow_imp.id(13700000000000022)
,p_name=>'Is Manager'
,p_scheme_type=>'NATIVE_FUNCTION_BODY'
,p_attribute_01=>'return sales_pkg.is_manager(:APP_USER);'
,p_error_message=>'Managers only.'
,p_caching=>'BY_USER_BY_SESSION'
);
end;
/
prompt --application/shared_components/user_interface/lovs/status
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(13700000000000030)
,p_lov_name=>'STATUS'
,p_lov_query=>'.'||wwv_flow_imp.id(13700000000000030)||'.'
,p_location=>'STATIC_VALUES'
,p_version_scn=>41228906654321
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(13700000000000031)
,p_lov_disp_sequence=>2
,p_lov_disp_value=>'Shipped'
,p_lov_return_value=>'SHIPPED'
);
wwv_flow_imp_shared.create_static_lov_data(
 p_id=>wwv_flow_imp.id(13700000000000032)
,p_lov_disp_sequence=>1
,p_lov_disp_value=>'Open'
,p_lov_return_value=>'OPEN'
);
end;
/
prompt --application/shared_components/user_interface/lovs/customers_lov
begin
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(13700000000000033)
,p_lov_name=>'CUSTOMERS.NAME'
,p_source_type=>'TABLE'
,p_location=>'LOCAL'
,p_query_table=>'CUSTOMERS'
,p_return_column_name=>'ID'
,p_display_column_name=>'NAME'
,p_default_sort_column_name=>'NAME'
,p_default_sort_direction=>'ASC'
);
wwv_flow_imp_shared.create_list_of_values(
 p_id=>wwv_flow_imp.id(13700000000000034)
,p_lov_name=>'PRODUCTS'
,p_lov_query=>q'[select name || ' (' || nvl(code, '-') || ')' d, id r from products order by 1]'
,p_source_type=>'LEGACY_SQL'
,p_location=>'LOCAL'
);
end;
/
prompt --application/pages/page_00000
begin
wwv_flow_imp_page.create_page(
 p_id=>0
,p_name=>'Global Page'
,p_step_title=>'Global Page'
,p_autocomplete_on_off=>'OFF'
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'D'
,p_page_component_map=>'14'
);
end;
/
prompt --application/pages/page_00001
begin
wwv_flow_imp_page.create_page(
 p_id=>1
,p_name=>'Home'
,p_alias=>'HOME'
,p_step_title=>'Order''s Desk'
,p_autocomplete_on_off=>'OFF'
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_page_component_map=>'13'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000101)
,p_plug_name=>'Welcome'
,p_region_template_options=>'#DEFAULT#:t-HeroRegion--hideIcon'
,p_plug_template=>wwv_flow_imp.id(13700000000000098)
,p_plug_display_sequence=>10
,p_plug_display_point=>'REGION_POSITION_01'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'<p>Welcome to the <strong>order desk</strong>, &APP_USER.</p>',
'<p>Caf'||unistr('\00e9')||' &amp; more.</p>'))
,p_plug_query_options=>'DERIVED_REPORT_COLUMNS'
,p_attribute_01=>'N'
,p_attribute_02=>'HTML'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000102)
,p_plug_name=>'Sales by Month'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>wwv_flow_imp.id(13700000000000097)
,p_plug_display_sequence=>20
,p_plug_display_point=>'BODY'
,p_plug_source_type=>'NATIVE_JET_CHART'
);
wwv_flow_imp_page.create_jet_chart(
 p_id=>wwv_flow_imp.id(13700000000000103)
,p_region_id=>wwv_flow_imp.id(13700000000000102)
,p_chart_type=>'bar'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000104)
,p_plug_name=>'News'
,p_plug_display_sequence=>30
,p_plug_display_point=>'BODY'
,p_plug_source=>'htp.p(''<b>'' || sales_pkg.news || ''</b>'');'
,p_plug_source_type=>'NATIVE_PLSQL'
);
end;
/
prompt --application/pages/page_00002
begin
wwv_flow_imp_page.create_page(
 p_id=>2
,p_name=>'Orders'
,p_alias=>'ORDERS'
,p_step_title=>'Orders'
,p_autocomplete_on_off=>'OFF'
,p_page_template_options=>'#DEFAULT#'
,p_protection_level=>'C'
,p_help_text=>'All orders, newest first.'
,p_page_component_map=>'18'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000201)
,p_plug_name=>'Orders'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>wwv_flow_imp.id(13700000000000097)
,p_plug_display_sequence=>10
,p_query_type=>'SQL'
,p_plug_source=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select o.id, o.customer_id, o.status, o.total, nvl(o.note, ''-'') note',
'  from orders o',
' where (:P2_STATUS is null or o.status = :P2_STATUS)'))
,p_plug_source_type=>'NATIVE_IR'
,p_prn_page_header=>'Orders'
);
wwv_flow_imp_page.create_worksheet(
 p_id=>wwv_flow_imp.id(13700000000000202)
,p_max_row_count=>'1000000'
,p_show_detail_link=>'C'
,p_detail_link=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:RP:P3_ID:\#ID#\'
,p_owner=>'DEV'
,p_internal_uid=>13700000000000202
);
wwv_flow_imp_page.create_worksheet_column(
 p_id=>wwv_flow_imp.id(13700000000000203)
,p_db_column_name=>'ID'
,p_display_order=>10
,p_column_identifier=>'A'
,p_column_label=>'ID'
,p_column_type=>'NUMBER'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000204)
,p_plug_name=>'Top customers'
,p_plug_display_sequence=>20
,p_query_type=>'TABLE'
,p_query_table=>'CUSTOMERS'
,p_query_where=>'rownum <= 5'
,p_plug_source_type=>'NATIVE_SQL_REPORT'
,p_plug_display_condition_type=>'USER_IS_NOT_PUBLIC_USER'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(13700000000000205)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(13700000000000201)
,p_button_name=>'CREATE'
,p_button_action=>'REDIRECT_PAGE'
,p_button_template_options=>'#DEFAULT#'
,p_button_template_id=>wwv_flow_imp.id(13700000000000096)
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'RIGHT_OF_IR_SEARCH_BAR'
,p_button_redirect_url=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:3::'
,p_security_scheme=>wwv_flow_imp.id(13700000000000021)
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000206)
,p_name=>'P2_STATUS'
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(13700000000000201)
,p_prompt=>'Status'
,p_display_as=>'NATIVE_SELECT_LIST'
,p_named_lov=>'STATUS'
,p_lov_display_null=>'YES'
,p_cHeight=>1
,p_field_template=>wwv_flow_imp.id(13700000000000095)
,p_item_template_options=>'#DEFAULT#'
,p_lov_display_extra=>'YES'
,p_attribute_01=>'SUBMIT'
,p_attribute_03=>'N'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000207)
,p_name=>'Refresh on status'
,p_event_sequence=>10
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P2_STATUS'
,p_bind_type=>'bind'
,p_execution_type=>'IMMEDIATE'
,p_bind_event_type=>'change'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000208)
,p_event_id=>wwv_flow_imp.id(13700000000000207)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(13700000000000201)
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000209)
,p_name=>'Refresh after dialog'
,p_event_sequence=>20
,p_triggering_element_type=>'REGION'
,p_triggering_region_id=>wwv_flow_imp.id(13700000000000201)
,p_bind_type=>'bind'
,p_bind_event_type=>'apexafterclosedialog'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000210)
,p_event_id=>wwv_flow_imp.id(13700000000000209)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_action=>'NATIVE_REFRESH'
,p_affected_elements_type=>'REGION'
,p_affected_region_id=>wwv_flow_imp.id(13700000000000201)
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000211)
,p_event_id=>wwv_flow_imp.id(13700000000000209)
,p_event_result=>'TRUE'
,p_action_sequence=>20
,p_execute_on_page_init=>'N'
,p_action=>'NATIVE_JAVASCRIPT_CODE'
,p_attribute_01=>'apex.message.showPageSuccess("Saved");'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000212)
,p_name=>'Highlight rows'
,p_event_sequence=>30
,p_triggering_element_type=>'JQUERY_SELECTOR'
,p_triggering_element=>'#orders td'
,p_bind_type=>'live'
,p_bind_event_type=>'click'
);
end;
/
prompt --application/pages/page_00003
begin
wwv_flow_imp_page.create_page(
 p_id=>3
,p_name=>'Order'
,p_alias=>'ORDER'
,p_page_mode=>'MODAL'
,p_step_title=>'Order'
,p_autocomplete_on_off=>'OFF'
,p_page_template_options=>'#DEFAULT#'
,p_required_role=>wwv_flow_imp.id(13700000000000021)
,p_protection_level=>'C'
,p_page_component_map=>'16'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000301)
,p_plug_name=>'Order'
,p_region_template_options=>'#DEFAULT#'
,p_plug_template=>wwv_flow_imp.id(13700000000000097)
,p_plug_display_sequence=>10
,p_query_type=>'TABLE'
,p_query_table=>'ORDERS'
,p_include_rowid_column=>false
,p_is_editable=>true
,p_edit_operations=>'i:u:d'
,p_lost_update_check_type=>'VALUES'
,p_plug_source_type=>'NATIVE_FORM'
);
wwv_flow_imp_page.create_page_plug(
 p_id=>wwv_flow_imp.id(13700000000000302)
,p_plug_name=>'Buttons'
,p_plug_display_sequence=>20
,p_plug_display_point=>'REGION_POSITION_03'
,p_attribute_01=>'N'
,p_attribute_02=>'TEXT'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(13700000000000303)
,p_button_sequence=>10
,p_button_plug_id=>wwv_flow_imp.id(13700000000000302)
,p_button_name=>'CANCEL'
,p_button_action=>'DEFINED_BY_DA'
,p_button_image_alt=>'Cancel'
,p_button_position=>'CLOSE'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(13700000000000304)
,p_button_sequence=>20
,p_button_plug_id=>wwv_flow_imp.id(13700000000000302)
,p_button_name=>'DELETE'
,p_button_action=>'REDIRECT_URL'
,p_button_image_alt=>'Delete'
,p_button_position=>'DELETE'
,p_button_redirect_url=>'javascript:apex.confirm(htmldb_delete_message,''DELETE'');'
,p_button_execute_validations=>'N'
,p_button_condition=>'P3_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'DELETE'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(13700000000000305)
,p_button_sequence=>30
,p_button_plug_id=>wwv_flow_imp.id(13700000000000302)
,p_button_name=>'SAVE'
,p_button_action=>'SUBMIT'
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Apply Changes'
,p_button_position=>'NEXT'
,p_button_condition=>'P3_ID'
,p_button_condition_type=>'ITEM_IS_NOT_NULL'
,p_database_action=>'UPDATE'
);
wwv_flow_imp_page.create_page_button(
 p_id=>wwv_flow_imp.id(13700000000000306)
,p_button_sequence=>40
,p_button_plug_id=>wwv_flow_imp.id(13700000000000302)
,p_button_name=>'CREATE'
,p_button_action=>'SUBMIT'
,p_button_is_hot=>'Y'
,p_button_image_alt=>'Create'
,p_button_position=>'NEXT'
,p_button_condition=>'P3_ID'
,p_button_condition_type=>'ITEM_IS_NULL'
,p_database_action=>'INSERT'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(13700000000000307)
,p_branch_name=>'Go to orders'
,p_branch_action=>'f?p=&APP_ID.:2:&SESSION.&success_msg=#SUCCESS_MSG#'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>10
,p_branch_condition_type=>'REQUEST_IN_CONDITION'
,p_branch_condition=>'SAVE,CREATE'
);
wwv_flow_imp_page.create_page_branch(
 p_id=>wwv_flow_imp.id(13700000000000308)
,p_branch_name=>'Elsewhere'
,p_branch_action=>'https://example.com/elsewhere'
,p_branch_point=>'AFTER_PROCESSING'
,p_branch_type=>'REDIRECT_URL'
,p_branch_sequence=>20
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000310)
,p_name=>'P3_ID'
,p_source_data_type=>'NUMBER'
,p_is_primary_key=>true
,p_is_query_only=>true
,p_item_sequence=>10
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_source=>'ID'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_HIDDEN'
,p_is_persistent=>'N'
,p_protection_level=>'S'
,p_attribute_01=>'Y'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000311)
,p_name=>'P3_CUSTOMER_ID'
,p_source_data_type=>'NUMBER'
,p_is_required=>true
,p_item_sequence=>20
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'Customer'
,p_source=>'CUSTOMER_ID'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_POPUP_LOV'
,p_named_lov=>'CUSTOMERS.NAME'
,p_cSize=>32
,p_help_text=>'Who ordered.'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000312)
,p_name=>'P3_STATUS'
,p_source_data_type=>'VARCHAR2'
,p_item_sequence=>30
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_default=>'OPEN'
,p_prompt=>'Status'
,p_source=>'STATUS'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_RADIOGROUP'
,p_lov=>'STATIC2:Open;OPEN,Shipped;SHIPPED,Cancelled;CANCELLED'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000313)
,p_name=>'P3_TOTAL'
,p_source_data_type=>'NUMBER'
,p_item_sequence=>40
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'Total'
,p_source=>'TOTAL'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_NUMBER_FIELD'
,p_format_mask=>'FML999G999G990D00'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000314)
,p_name=>'P3_ORDERED_ON'
,p_source_data_type=>'DATE'
,p_item_sequence=>50
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_default=>'sysdate'
,p_item_default_type=>'EXPRESSION'
,p_item_default_language=>'PLSQL'
,p_prompt=>'Ordered on'
,p_source=>'ORDERED_ON'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_DATE_PICKER_APEX'
,p_format_mask=>'DD-MON-YYYY'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000315)
,p_name=>'P3_EMAIL'
,p_item_sequence=>60
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'E-mail'
,p_source=>'EMAIL'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_attribute_01=>'EMAIL'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000316)
,p_name=>'P3_NOTE'
,p_item_sequence=>70
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_item_source_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'Note'
,p_source=>'NOTE'
,p_source_type=>'REGION_SOURCE_COLUMN'
,p_display_as=>'NATIVE_TEXTAREA'
,p_display_when=>'P3_ID'
,p_display_when_type=>'ITEM_IS_NOT_NULL'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000317)
,p_name=>'P3_CODE'
,p_item_sequence=>80
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'Code'
,p_display_as=>'NATIVE_TEXT_FIELD'
,p_display_when=>'return sales_pkg.show_code;'
,p_display_when_type=>'FUNCTION_BODY'
);
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000318)
,p_name=>'P3_RATING'
,p_item_sequence=>90
,p_item_plug_id=>wwv_flow_imp.id(13700000000000301)
,p_prompt=>'<b>Rating</b>'
,p_display_as=>'PLUGIN_COM_EXAMPLE_STARS'
);
wwv_flow_imp_page.create_page_computation(
 p_id=>wwv_flow_imp.id(13700000000000320)
,p_computation_sequence=>10
,p_computation_item=>'P3_CODE'
,p_computation_point=>'BEFORE_HEADER'
,p_computation_type=>'QUERY'
,p_computation=>'select code from orders where id = :P3_ID'
,p_compute_when=>'P3_ID'
,p_compute_when_type=>'ITEM_IS_NOT_NULL'
);
wwv_flow_imp_page.create_page_computation(
 p_id=>wwv_flow_imp.id(13700000000000321)
,p_computation_sequence=>20
,p_computation_item=>'P3_NOTE'
,p_computation_point=>'AFTER_SUBMIT'
,p_computation_type=>'EXPRESSION'
,p_computation_language=>'PLSQL'
,p_computation=>'trim(:P3_NOTE)'
);
wwv_flow_imp_page.create_page_computation(
 p_id=>wwv_flow_imp.id(13700000000000322)
,p_computation_sequence=>30
,p_computation_item=>'P3_TOTAL'
,p_computation_point=>'AFTER_SUBMIT'
,p_computation_type=>'QUERY_COLON'
,p_computation=>'select id from orders'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000330)
,p_validation_name=>'Customer not null'
,p_validation_sequence=>10
,p_validation=>'P3_CUSTOMER_ID'
,p_validation_type=>'ITEM_NOT_NULL'
,p_error_message=>'#LABEL# must have some value.'
,p_associated_item=>wwv_flow_imp.id(13700000000000311)
,p_error_display_location=>'INLINE_WITH_FIELD_AND_NOTIFICATION'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000331)
,p_validation_name=>'Total is numeric'
,p_validation_sequence=>20
,p_validation=>'P3_TOTAL'
,p_validation_type=>'ITEM_IS_NUMERIC'
,p_error_message=>'#LABEL# must be numeric.'
,p_associated_item=>wwv_flow_imp.id(13700000000000313)
,p_error_display_location=>'INLINE_WITH_FIELD'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000332)
,p_validation_name=>'Total not null or zero'
,p_validation_sequence=>21
,p_validation=>'P3_TOTAL'
,p_validation_type=>'ITEM_NOT_NULL_OR_ZERO'
,p_error_message=>'Enter a total.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000333)
,p_validation_name=>'Total not zero'
,p_validation_sequence=>22
,p_validation=>'P3_TOTAL'
,p_validation_type=>'ITEM_NOT_ZERO'
,p_error_message=>'Not zero.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000334)
,p_validation_name=>'Code has no spaces'
,p_validation_sequence=>30
,p_validation=>'P3_CODE'
,p_validation_type=>'ITEM_CONTAINS_NO_SPACES'
,p_error_message=>'No spaces.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000335)
,p_validation_name=>'Code alphanumeric'
,p_validation_sequence=>31
,p_validation=>'P3_CODE'
,p_validation_type=>'ITEM_IS_ALPHANUMERIC'
,p_error_message=>'Letters and digits.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000336)
,p_validation_name=>'Ordered on is a date'
,p_validation_sequence=>40
,p_validation=>'P3_ORDERED_ON'
,p_validation_type=>'ITEM_IS_DATE'
,p_error_message=>'#LABEL# is not a valid date.'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000337)
,p_validation_name=>'Ordered on is a timestamp'
,p_validation_sequence=>41
,p_validation=>'P3_ORDERED_ON'
,p_validation_type=>'ITEM_IS_TIMESTAMP'
,p_error_message=>'Not a timestamp.'
,p_error_display_location=>'ON_ERROR_PAGE'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000338)
,p_validation_name=>'Status = OPEN'
,p_validation_sequence=>50
,p_validation=>'P3_STATUS'
,p_validation2=>'OPEN'
,p_validation_type=>'ITEM_IN_VALIDATION_EQ_STRING2'
,p_error_message=>'Only open orders.'
,p_validation_condition=>'CREATE'
,p_validation_condition_type=>'REQUEST_EQUALS_CONDITION'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000339)
,p_validation_name=>'Status != X'
,p_validation_sequence=>51
,p_validation=>'P3_STATUS'
,p_validation2=>'X'
,p_validation_type=>'ITEM_IN_VALIDATION_NOT_EQ_STRING2'
,p_error_message=>'Not X.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000340)
,p_validation_name=>'Status in list'
,p_validation_sequence=>52
,p_validation=>'P3_STATUS'
,p_validation2=>'OPEN:SHIPPED:CANCELLED'
,p_validation_type=>'ITEM_IN_VALIDATION_IN_STRING2'
,p_error_message=>'Unknown status.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000341)
,p_validation_name=>'Status not in list'
,p_validation_sequence=>53
,p_validation=>'P3_STATUS'
,p_validation2=>'DRAFT:TEST'
,p_validation_type=>'ITEM_IN_VALIDATION_NOT_IN_STRING2'
,p_error_message=>'Not a draft.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000342)
,p_validation_name=>'Code only letters'
,p_validation_sequence=>60
,p_validation=>'P3_CODE'
,p_validation2=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
,p_validation_type=>'ITEM_IN_VALIDATION_CONTAINS_ONLY_CHAR_IN_STRING2'
,p_error_message=>'Capitals only.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000343)
,p_validation_name=>'E-mail has an @'
,p_validation_sequence=>61
,p_validation=>'P3_EMAIL'
,p_validation2=>'@'
,p_validation_type=>'ITEM_IN_VALIDATION_CONTAINS_AT_LEAST_ONE_CHAR_IN_STRING2'
,p_error_message=>'An e-mail address has an @.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000344)
,p_validation_name=>'Note without brackets'
,p_validation_sequence=>62
,p_validation=>'P3_NOTE'
,p_validation2=>'<>{}'
,p_validation_type=>'ITEM_IN_VALIDATION_CONTAINS_NO_CHAR_IN_STRING2'
,p_error_message=>'No brackets.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000345)
,p_validation_name=>'E-mail looks like an address'
,p_validation_sequence=>63
,p_validation=>'P3_EMAIL'
,p_validation2=>q'{^[^@]+@[^@]+\.[A-Za-z]{2,}$}'
,p_validation_type=>'REGULAR_EXPRESSION'
,p_error_message=>'Not an e-mail address.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000346)
,p_validation_name=>'Customer exists'
,p_validation_sequence=>70
,p_validation=>'select 1 from customers where id = :P3_CUSTOMER_ID'
,p_validation_type=>'EXISTS'
,p_error_message=>'Unknown customer.'
,p_associated_item=>wwv_flow_imp.id(13700000000000311)
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000347)
,p_validation_name=>'Code not taken'
,p_validation_sequence=>71
,p_validation=>wwv_flow_string.join(wwv_flow_t_varchar2(
'select 1',
'  from orders',
' where code = :P3_CODE',
'   and id <> nvl(:P3_ID, -1)'))
,p_validation_type=>'NOT_EXISTS'
,p_error_message=>'The code &P3_CODE. is taken.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000348)
,p_validation_name=>'Total positive'
,p_validation_sequence=>80
,p_validation=>':P3_TOTAL > 0'
,p_validation2=>'SQL'
,p_validation_type=>'EXPRESSION'
,p_error_message=>'The total is positive.'
,p_associated_item=>wwv_flow_imp.id(13700000000000313)
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000349)
,p_validation_name=>'Total below limit'
,p_validation_sequence=>81
,p_validation=>'sales_pkg.below_limit(:P3_TOTAL)'
,p_validation2=>'PLSQL'
,p_validation_type=>'EXPRESSION'
,p_error_message=>'Above the limit.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000350)
,p_validation_name=>'Shipped orders keep their total'
,p_validation_sequence=>82
,p_validation=>wwv_flow_string.join(wwv_flow_t_varchar2(
'begin',
'  if :P3_STATUS = ''SHIPPED'' and :P3_TOTAL is null then',
'    return false;',
'  end if;',
'  return true;',
'end;'))
,p_validation2=>'PLSQL'
,p_validation_type=>'FUNC_BODY_RETURNING_BOOLEAN'
,p_error_message=>'A shipped order has a total.'
,p_validation_condition=>'SAVE'
,p_validation_condition_type=>'REQUEST_EQUALS_CONDITION'
,p_always_execute=>'Y'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000351)
,p_validation_name=>'Credit check'
,p_validation_sequence=>83
,p_validation=>q'[return sales_pkg.credit_error(:P3_CUSTOMER_ID, :P3_TOTAL);]'
,p_validation2=>'PLSQL'
,p_validation_type=>'FUNC_BODY_RETURNING_ERR_TEXT'
,p_error_message=>'Error'
,p_when_button_pressed=>wwv_flow_imp.id(13700000000000306)
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000352)
,p_validation_name=>'Legacy PL/SQL error'
,p_validation_sequence=>84
,p_validation=>'sales_pkg.check_order(:P3_ID);'
,p_validation_type=>'PLSQL_ERROR'
,p_error_message=>'Failed.'
);
wwv_flow_imp_page.create_page_validation(
 p_id=>wwv_flow_imp.id(13700000000000353)
,p_validation_name=>'Stars plug-in'
,p_validation_sequence=>85
,p_validation=>'P3_RATING'
,p_validation_type=>'PLUGIN_COM_EXAMPLE_STARS_VALID'
,p_error_message=>'Bad stars.'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000360)
,p_process_sequence=>10
,p_process_point=>'BEFORE_HEADER'
,p_region_id=>wwv_flow_imp.id(13700000000000301)
,p_process_type=>'NATIVE_FORM_INIT'
,p_process_name=>'Initialize form Order'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000361)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_region_id=>wwv_flow_imp.id(13700000000000301)
,p_process_type=>'NATIVE_FORM_DML'
,p_process_name=>'Process form Order'
,p_attribute_01=>'REGION_SOURCE'
,p_attribute_05=>'Y'
,p_attribute_06=>'Y'
,p_attribute_08=>'Y'
,p_process_success_message=>'Order &P3_ID. saved.'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000362)
,p_process_sequence=>20
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Log the change'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'begin',
'  insert into order_log (order_id, action, by_user, at)',
'  values (:P3_ID, :REQUEST, :APP_USER, sysdate);',
'end;'))
,p_process_clob_language=>'PLSQL'
,p_error_display_location=>'INLINE_IN_NOTIFICATION'
,p_process_when=>'DELETE'
,p_process_when_type=>'REQUEST_NOT_EQUAL_CONDITION'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000363)
,p_process_sequence=>30
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_SEND_EMAIL'
,p_process_name=>'Mail the customer'
,p_attribute_01=>'orders@example.com'
,p_attribute_02=>'&P3_EMAIL.'
,p_attribute_06=>'Order &P3_ID.'
,p_attribute_07=>wwv_flow_string.join(wwv_flow_t_varchar2(
'Dear customer,',
'',
'your order &P3_ID. is &P3_STATUS..'))
,p_attribute_10=>'Y'
,p_process_when_button_id=>wwv_flow_imp.id(13700000000000305)
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000364)
,p_process_sequence=>40
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_SESSION_STATE'
,p_process_name=>'Clear the note'
,p_attribute_01=>'CLEAR_CACHE_FOR_ITEMS'
,p_attribute_02=>'P3_NOTE,P3_CODE'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000365)
,p_process_sequence=>41
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_SESSION_STATE'
,p_process_name=>'Clear the page'
,p_attribute_01=>'CLEAR_CACHE_CURRENT_PAGE'
,p_process_when_button_id=>wwv_flow_imp.id(13700000000000306)
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000366)
,p_process_sequence=>50
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_INVOKE_API'
,p_process_name=>'Recalculate'
,p_attribute_01=>'PLSQL_PACKAGE'
,p_attribute_03=>'SALES_PKG'
,p_attribute_04=>'RECALCULATE'
);
wwv_flow_imp_page.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(13700000000000367)
,p_page_process_id=>wwv_flow_imp.id(13700000000000366)
,p_page_id=>3
,p_name=>'p_order_id'
,p_direction=>'IN'
,p_data_type=>'NUMBER'
,p_has_default=>false
,p_display_sequence=>10
,p_value_type=>'ITEM'
,p_value=>'P3_ID'
);
wwv_flow_imp_page.create_invokeapi_comp_param(
 p_id=>wwv_flow_imp.id(13700000000000368)
,p_page_process_id=>wwv_flow_imp.id(13700000000000366)
,p_page_id=>3
,p_name=>'p_mode'
,p_direction=>'IN'
,p_data_type=>'VARCHAR2'
,p_display_sequence=>20
,p_value_type=>'STATIC'
,p_value=>'FULL'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000369)
,p_process_sequence=>60
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_CLOSE_WINDOW'
,p_process_name=>'Close Dialog'
,p_attribute_01=>'P3_ID'
,p_attribute_02=>'Y'
,p_process_when=>'CREATE,SAVE,DELETE'
,p_process_when_type=>'REQUEST_IN_CONDITION'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000370)
,p_process_sequence=>70
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_WEB_SERVICE'
,p_process_name=>'Legacy web service'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000371)
,p_process_sequence=>80
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'PLUGIN_COM_EXAMPLE_AUDIT'
,p_process_name=>'Audit plug-in'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000000372)
,p_process_sequence=>90
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_USER_PREFERENCES'
,p_process_name=>'Remember the status'
,p_attribute_01=>'SET_PREFERENCE_TO_ITEM_VALUE'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000380)
,p_name=>'Cancel Dialog'
,p_event_sequence=>10
,p_triggering_element_type=>'BUTTON'
,p_triggering_button_id=>wwv_flow_imp.id(13700000000000303)
,p_bind_type=>'bind'
,p_bind_event_type=>'click'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000381)
,p_event_id=>wwv_flow_imp.id(13700000000000380)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_action=>'NATIVE_DIALOG_CANCEL'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000382)
,p_name=>'Show the note for shipped'
,p_event_sequence=>20
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P3_STATUS'
,p_condition_element=>'P3_STATUS'
,p_triggering_condition_type=>'EQUALS'
,p_triggering_expression=>'SHIPPED'
,p_bind_type=>'bind'
,p_bind_event_type=>'change'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000383)
,p_event_id=>wwv_flow_imp.id(13700000000000382)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'Y'
,p_action=>'NATIVE_SHOW'
,p_affected_elements_type=>'ITEM'
,p_affected_elements=>'P3_NOTE'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000384)
,p_event_id=>wwv_flow_imp.id(13700000000000382)
,p_event_result=>'FALSE'
,p_action_sequence=>10
,p_execute_on_page_init=>'Y'
,p_action=>'NATIVE_HIDE'
,p_affected_elements_type=>'ITEM'
,p_affected_elements=>'P3_NOTE'
);
wwv_flow_imp_page.create_page_da_event(
 p_id=>wwv_flow_imp.id(13700000000000385)
,p_name=>'Fill the total'
,p_event_sequence=>30
,p_triggering_element_type=>'ITEM'
,p_triggering_element=>'P3_CUSTOMER_ID'
,p_bind_type=>'bind'
,p_bind_event_type=>'change'
);
wwv_flow_imp_page.create_page_da_action(
 p_id=>wwv_flow_imp.id(13700000000000386)
,p_event_id=>wwv_flow_imp.id(13700000000000385)
,p_event_result=>'TRUE'
,p_action_sequence=>10
,p_execute_on_page_init=>'N'
,p_action=>'NATIVE_SET_VALUE'
,p_affected_elements_type=>'ITEM'
,p_affected_elements=>'P3_TOTAL'
,p_attribute_01=>'SQL_STATEMENT'
,p_attribute_03=>'select credit_limit from customers where id = :P3_CUSTOMER_ID'
,p_attribute_07=>'P3_CUSTOMER_ID'
,p_attribute_08=>'Y'
,p_attribute_09=>'N'
);
end;
/
prompt --application/pages/page_09999
begin
wwv_flow_imp_page.create_page(
 p_id=>9999
,p_name=>'Login Page'
,p_alias=>'LOGIN'
,p_step_title=>'Order''s Desk - Log In'
,p_warn_on_unsaved_changes=>'N'
,p_first_item=>'AUTO_FIRST_ITEM'
,p_autocomplete_on_off=>'OFF'
,p_page_template_options=>'#DEFAULT#'
,p_page_is_public_y_n=>'Y'
,p_protection_level=>'C'
);
wwv_flow_imp_page.create_page_process(
 p_id=>wwv_flow_imp.id(13700000000009991)
,p_process_sequence=>10
,p_process_point=>'AFTER_SUBMIT'
,p_process_type=>'NATIVE_PLSQL'
,p_process_name=>'Login'
,p_process_sql_clob=>wwv_flow_string.join(wwv_flow_t_varchar2(
'apex_authentication.login(',
'    p_username => :P9999_USERNAME,',
'    p_password => :P9999_PASSWORD );'))
,p_process_clob_language=>'PLSQL'
);
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
