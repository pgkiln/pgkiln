-- =====================================================================
-- 076: lost update detection for forms (APEX: "Prevent Lost Updates" and
-- "Lock Row" of the Form - Automatic Row Processing (DML) process)
--
-- When a form region fetches its row, the page also gets a checksum of the
-- row's form columns (meta.row_version). An update or delete through the
-- form_dml process locks the row (FOR UPDATE), computes the checksum again
-- and refuses the save when it differs: someone else changed the row since
-- the page was shown.
--
-- The checksum is computed under fixed settings (UTC, ISO dates, all float
-- digits), so it does not depend on the user's time zone or the session's
-- formats. The function runs with the caller's rights: the application's
-- role, its grants and its row level security policies.
-- =====================================================================

create function meta.row_version(p_table regclass, p_pk_column text, p_pk text, p_columns text[], p_lock boolean default false)
returns text
language plpgsql
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
set intervalstyle = 'iso_8601'
set extra_float_digits = 3
set search_path = pg_catalog
as $$
declare
  v_cols text;
  v_type text;
  v_out  text;
begin
  -- the key's own type, so the lookup uses the primary key's index
  select format_type(a.atttypid, a.atttypmod) into v_type
    from pg_attribute a where a.attrelid = p_table and a.attname = p_pk_column and a.attnum > 0 and not a.attisdropped;
  if v_type is null then
    raise exception 'column % does not exist in %', p_pk_column, p_table;
  end if;
  -- each column as text in the row, in the given order
  select string_agg(format('%I::text', c), ', ' order by o) into v_cols
    from unnest(p_columns) with ordinality as x(c, o);
  execute format('select md5(row(%s)::text) from %s where %I = $1::%s%s',
                 coalesce(v_cols, format('%I::text', p_pk_column)), p_table, p_pk_column, v_type,
                 case when p_lock then ' for update' else '' end)
    into v_out using p_pk;
  return v_out;
end
$$;
grant execute on function meta.row_version(regclass, text, text, text[], boolean) to public;

comment on function meta.row_version(regclass, text, text, text[], boolean) is
  'A checksum of a row''s columns (lost update detection of forms, 076); NULL when the row is not found or not visible';
