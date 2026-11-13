prompt --application/set_environment
set define off verify off feedback off
begin
wwv_flow_api.import_begin (
 p_version_yyyy_mm_dd=>'2019.10.04'
,p_release=>'19.2.0.00.18'
,p_default_workspace_id=>1550000000000
,p_default_application_id=>200
,p_default_owner=>'HRAPP'
);
end;
/
