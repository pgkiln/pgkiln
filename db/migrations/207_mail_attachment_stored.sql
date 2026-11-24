-- =====================================================================
-- 207: a mail attachment from object storage (sprint 253, MG-30)
--
-- A file item with config.object_store keeps its files in an S3 bucket or
-- in OneDrive / SharePoint (071, 199); its column holds only the key. SQL
-- has no bytes to give meta.add_mail_attachment, so
-- meta.add_mail_attachment_stored(mail, item, key, filename, mime) adds an
-- attachment *by reference*: the row keeps the file item's name and the
-- key, and the mail sender fetches the file from that item's store when it
-- sends the mail (src/mail/mail.ts, src/objectstore.ts storedObject). A
-- fetch that fails is retried like any other failure of the attempt; a
-- file that is not there fails the mail.
--
-- Safety: the item must be a file item of the calling application that has
-- an object store (checked here and again when sending); the key must lie
-- in that store (an S3 key below the static part of its prefix; a drive
-- item in the configured folder or below it), as for a download. Which
-- keys the process reads is up to the application's role: RLS applies to
-- the query that finds them. The limits of meta.add_mail_attachment apply
-- (20 attachments; 10 MB each and 20 MB per mail, checked when sending).
-- =====================================================================

alter table meta.mail_attachment alter column content drop not null;
alter table meta.mail_attachment add column stored_item text check (stored_item ~ '^[A-Z][A-Z0-9_]{0,127}$');
alter table meta.mail_attachment add column stored_key text check (length(stored_key) between 1 and 1024);
alter table meta.mail_attachment add constraint mail_attachment_content_or_stored
  check (case when content is null then stored_item is not null and stored_key is not null else stored_item is null and stored_key is null end);

comment on column meta.mail_attachment.stored_item is
  'A file item of the mail''s application with an object store (meta.add_mail_attachment_stored): the sender fetches stored_key from it';

create function meta.add_mail_attachment_stored(p_mail bigint, p_item text, p_key text, p_filename text, p_mime text default 'application/octet-stream')
returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  c       record;
  v_count int;
begin
  select * into c from meta.mail_caller();
  if not exists (select 1 from meta.mail_queue where id = p_mail and app_id = c.app_id and status = 'queued' and created_xact = txid_current()) then
    raise exception 'meta.add_mail_attachment_stored: mail % was not queued in this transaction', p_mail;
  end if;
  if coalesce(p_key, '') = '' or length(p_key) > 1024 then
    raise exception 'meta.add_mail_attachment_stored: no key';
  end if;
  if not exists (select 1 from meta.item i join meta.page p on p.id = i.page_id
                  where p.app_id = c.app_id and i.name = upper(p_item) and i.type = 'file' and i.config ? 'object_store') then
    raise exception 'meta.add_mail_attachment_stored: % is not a file item with an object store in this application', p_item;
  end if;
  select count(*) into v_count from meta.mail_attachment where mail_id = p_mail;
  if v_count >= 20 then
    raise exception 'meta.add_mail_attachment: at most 20 attachments and 20 MB per mail';
  end if;
  insert into meta.mail_attachment (mail_id, filename, mime, stored_item, stored_key)
  values (p_mail, regexp_replace(coalesce(nullif(p_filename, ''), 'attachment'), '[/\\\r\n"<>:|?*]', '_', 'g'), lower(coalesce(p_mime, 'application/octet-stream')),
          upper(p_item), p_key);
end
$$;
grant execute on function meta.add_mail_attachment_stored(bigint, text, text, text, text) to public;
