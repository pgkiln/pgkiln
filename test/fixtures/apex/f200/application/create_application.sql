prompt --application/create_application
begin
wwv_flow_api.create_flow(
 p_id=>wwv_flow.g_flow_id
,p_owner=>nvl(wwv_flow_application_install.get_schema,'HRAPP')
,p_name=>nvl(wwv_flow_application_install.get_application_name,'Staff Directory')
,p_alias=>nvl(wwv_flow_application_install.get_application_alias,'')
,p_flow_language=>'de'
,p_home_link=>'f?p=&APP_ID.:10:&SESSION.'
);
end;
/
