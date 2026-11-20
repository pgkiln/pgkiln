-- =====================================================================
-- HR example, part 102: a signature on a leave request (sprint 239,
-- MG-12; migration 195; docs/guide/05-items.md "Signature")
--
-- Leave request (page 7) has a Signature item: the employee signs the
-- request with a finger, a pen or the mouse before submitting it. The
-- drawing is posted as a PNG and becomes a temporary file of the session
-- (like a file upload's); the process "Store the signature" reads it
-- from meta.temp_files into hr.leave_request.signature once the request
-- exists. An existing request shows the stored signature (the item's
-- source column), read only.
--
-- The audit trail leaves the picture out, as it does the employee photo.
-- =====================================================================
alter table hr.leave_request
  add column if not exists signature bytea,
  add constraint leave_signature_size check (octet_length(signature) <= 1024 * 1024);

drop trigger if exists leave_audit on hr.leave_request;
create trigger leave_audit after insert or update or delete on hr.leave_request
  for each row execute function hr.audit('id', 'signature');

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, readonly_condition, help)
select p.id, r.id, 75, 'P7_SIGNATURE', 'Signature', 'signature', 'signature', ':P7_ID is not null',
       'Sign with a finger, a pen or the mouse. Without a drawing pad, upload a PNG picture of your signature.'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 7
   and not exists (select 1 from meta.item x where x.page_id = p.id and x.name = 'P7_SIGNATURE');

-- after "Request leave" (seq 10), which sets P7_ID; no signature drawn: nothing to store
insert into meta.process (page_id, seq, name, type, code, when_button, condition_type, condition_expr)
select p.id, 15, 'Store the signature', 'sql',
       $q$update hr.leave_request
   set signature = (select t.content from meta.temp_files t where t.id = :P7_SIGNATURE::uuid)
 where id = :P7_ID::int$q$,
       'CREATE', 'item_not_null', 'P7_SIGNATURE'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 7
   and not exists (select 1 from meta.process x where x.page_id = p.id and x.name = 'Store the signature');

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Signature', 'Handtekening'),
  ('Sign with a finger, a pen or the mouse. Without a drawing pad, upload a PNG picture of your signature.',
   'Teken met een vinger, een pen of de muis. Zonder tekenvlak upload je een PNG-afbeelding van je handtekening.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
