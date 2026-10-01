-- =====================================================================
-- HR sample, part 5: files (see docs/guide/16-files.md)
--
--   * an employee photo: a file upload item on the employee form, saved in
--     hr.emp.photo with its file name and type
--   * the audit trail leaves the photo itself out (only its name changes
--     are recorded), so the log doesn't fill up with images
-- =====================================================================

alter table hr.emp
  add column photo      bytea,
  add column photo_name text,
  add column photo_mime text,
  add constraint emp_photo_size check (octet_length(photo) <= 2 * 1024 * 1024);

-- hr.audit('pk', 'column to leave out', ...)
create or replace function hr.audit() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_skip text[] := coalesce(tg_argv[1:], '{}');
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - v_skip end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - v_skip end;
  v_pk  text  := coalesce(v_new, v_old) ->> tg_argv[0];
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, n.value) into v_new
      from jsonb_each(to_jsonb(new) - v_skip) n
     where n.value is distinct from v_old -> n.key;
    if v_new is null then
      return new;  -- nothing changed
    end if;
    select jsonb_object_agg(o.key, o.value) into v_old
      from jsonb_each(to_jsonb(old) - v_skip) o
     where v_new ? o.key;
  end if;
  insert into hr.audit_log (table_name, row_pk, action, changed_by, old_values, new_values)
  values (tg_table_name, v_pk, tg_op, meta.app_user(), v_old, v_new);
  return coalesce(new, old);
end
$$;

drop trigger emp_audit on hr.emp;
create trigger emp_audit after insert or update or delete on hr.emp
  for each row execute function hr.audit('empno', 'photo');

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help, config)
select p.id, r.id, 110, 'P3_PHOTO', 'Photo', 'file', 'photo', 'A JPEG, PNG or WebP image of at most 2 MB.',
       '{"filename_column": "photo_name", "mime_column": "photo_mime", "accept": "image/png,image/jpeg,image/webp", "max_mb": 2}'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Photo', 'Foto'),
  ('A JPEG, PNG or WebP image of at most 2 MB.', 'Een JPEG-, PNG- of WebP-afbeelding van maximaal 2 MB.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
