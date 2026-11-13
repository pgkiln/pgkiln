-- ---------------------------------------------------------------------
-- 159: response headers of a PL/pgSQL REST handler (sprint 176, Database
-- Actions DA-11 leftover: what ORDS does with an OUT parameter bound to
-- an HTTP header). meta.rest_header('Location', '/a/app/rest/m/orders/7')
-- sets a header of the response, next to meta.rest_reply for its body and
-- status. Headers the server itself answers with (the content type and
-- length, cookies, the security headers, CORS, the ETag) are refused.
-- ---------------------------------------------------------------------
create function meta.rest_header(p_name text, p_value text) returns void
language plpgsql set search_path = pg_catalog as $$
declare
  v_name text := lower(p_name);
  v_all  jsonb := coalesce(nullif(current_setting('pgkiln_rest.headers', true), ''), '{}')::jsonb;
begin
  if v_name is null or v_name !~ '^[a-z][a-z0-9-]{0,63}$' then
    raise exception 'meta.rest_header: a header name is letters, digits and - (at most 64), not %', coalesce(p_name, 'null');
  end if;
  if v_name in ('content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
                'upgrade', 'trailer', 'te', 'host', 'date', 'etag', 'set-cookie', 'cookie', 'authorization',
                'www-authenticate', 'content-security-policy', 'content-security-policy-report-only',
                'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy',
                'permissions-policy', 'clear-site-data', 'server')
     or v_name like 'access-control-%' or v_name like 'cross-origin-%' or v_name like 'proxy-%' or v_name like 'sec-%' then
    raise exception 'meta.rest_header: the % header is set by the server', v_name;
  end if;
  if p_value is null then
    v_all := v_all - v_name;
  elsif length(p_value) > 2000 or p_value ~ '[\x01-\x1f\x7f]' then
    raise exception 'meta.rest_header: the value of % is one line of at most 2000 characters', v_name;
  else
    if (select count(*) from jsonb_object_keys(v_all)) >= 20 and not v_all ? v_name then
      raise exception 'meta.rest_header: at most 20 headers';
    end if;
    v_all := v_all || jsonb_build_object(v_name, p_value);
  end if;
  perform set_config('pgkiln_rest.headers', v_all::text, true);
end $$;
comment on function meta.rest_header(text, text) is 'REST handlers (159): a response header of a PL/pgSQL handler (null removes it); headers the server sets are refused';

grant execute on function meta.rest_header(text, text) to public;
