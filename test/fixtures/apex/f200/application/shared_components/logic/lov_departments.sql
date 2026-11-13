prompt --application/shared_components/user_interface/lovs/departments
begin
wwv_flow_api.create_list_of_values(
 p_id=>wwv_flow_api.id(1550000000100)+wwv_flow_api.g_id_offset
,p_lov_name=>'DEPARTMENTS'
,p_lov_query=>'select dname d, deptno r from dept order by 1'
);
end;
/
