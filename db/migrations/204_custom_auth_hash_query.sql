-- =====================================================================
-- 204: custom authentication with the password hashes of another system
-- (sprint 248, MG-21)
--
-- meta.app.custom_auth_hash_query: a query (run as the application's role,
-- with the parameter p_username) returning the stored password hash of the
-- user; the server checks the password against it (src/password-hashes.ts):
-- Django's pbkdf2_sha256$ and pbkdf2_sha1$ in Node (crypto.pbkdf2, a
-- constant-time comparison), bcrypt ($2a$, $2b$, $2y$: PHP's password_hash,
-- Django's bcrypt$ and bcrypt_sha256$) with pgcrypto's crypt(). Unknown users
-- get a dummy check of the same cost. argon2 hashes are refused.
-- An ordinary column of meta.app: exported and imported with the application.
--
-- meta.make_password_hash(p_password, p_format, p_cost) writes such a hash
-- (e.g. when a user changes the password, or for a new user): bcrypt (the
-- default, cost 12) or Django's pbkdf2_sha256 / pbkdf2_sha1 (1,000,000
-- iterations: about a second in PL/pgSQL, so for occasional writes only).
-- =====================================================================
alter table meta.app add column custom_auth_hash_query text check (length(custom_auth_hash_query) <= 20000);
comment on column meta.app.custom_auth_hash_query is
  'custom authentication (204): or a query with p_username returning the stored password hash (Django pbkdf2_sha256$/pbkdf2_sha1$, bcrypt $2a$/$2b$/$2y$); the server checks the password';

create function meta.make_password_hash(p_password text, p_format text default 'bcrypt', p_cost int default null) returns text
language plpgsql volatile set search_path = pg_catalog, public as $$
declare
  v_format text := lower(coalesce(p_format, 'bcrypt'));
  v_alg text;
  v_iter int;
  v_salt text := '';
  v_key bytea;
  v_u bytea;
  v_t varbit;
  v_dk bytea := '';
  v_chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
begin
  if p_password is null or p_password = '' then
    raise exception 'meta.make_password_hash: the password is empty';
  end if;
  if v_format = 'bcrypt' then
    if p_cost is not null and p_cost not between 4 and 16 then
      raise exception 'meta.make_password_hash: the bcrypt cost is 4 to 16, not %', p_cost;
    end if;
    return crypt(p_password, gen_salt('bf', coalesce(p_cost, 12)));
  end if;
  if v_format not in ('pbkdf2_sha256', 'pbkdf2_sha1') then
    raise exception 'meta.make_password_hash: unknown format % (bcrypt, pbkdf2_sha256 or pbkdf2_sha1)', p_format;
  end if;
  v_alg := substr(v_format, 8);
  v_iter := coalesce(p_cost, 1000000);
  if v_iter not between 1000 and 10000000 then
    raise exception 'meta.make_password_hash: the iterations are 1,000 to 10,000,000, not %', v_iter;
  end if;
  -- Django's salt: 22 letters and digits
  for i in 1..22 loop
    v_salt := v_salt || substr(v_chars, 1 + (get_byte(gen_random_bytes(1), 0) % 62), 1);
  end loop;
  -- PBKDF2 (RFC 8018) with one block: the derived key is as long as the digest, as Django's
  v_key := convert_to(p_password, 'UTF8');
  v_u := hmac(convert_to(v_salt, 'UTF8') || '\x00000001'::bytea, v_key, v_alg);
  v_t := ('x' || encode(v_u, 'hex'))::varbit;
  for i in 2..v_iter loop
    v_u := hmac(v_u, v_key, v_alg);
    v_t := v_t # ('x' || encode(v_u, 'hex'))::varbit;
  end loop;
  for i in 0..length(v_t) / 8 - 1 loop
    v_dk := v_dk || set_byte('\x00'::bytea, 0, substring(v_t from i * 8 + 1 for 8)::int);
  end loop;
  return format('%s$%s$%s$%s', v_format, v_iter, v_salt, encode(v_dk, 'base64'));
end $$;
comment on function meta.make_password_hash(text, text, int) is
  '(204) A password hash custom authentication''s hash query can check: bcrypt (default, cost 4-16, default 12) or Django''s pbkdf2_sha256 / pbkdf2_sha1 (iterations 1,000-10,000,000, default 1,000,000).';
grant execute on function meta.make_password_hash(text, text, int) to public;
