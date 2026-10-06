-- =====================================================================
-- 071: object storage for file items
--
-- A file item with config.object_store keeps its files in an S3-compatible
-- bucket; its source column then holds the object's key (src/objectstore.ts).
-- Requests are signed with AWS Signature Version 4 using a web credential of
-- the new type aws_sigv4: the access key id in username, the secret access
-- key as the (encrypted) secret, the region in scope.
-- =====================================================================

alter table meta.web_credential drop constraint web_credential_type_check;
alter table meta.web_credential add constraint web_credential_type_check
  check (type in ('basic', 'header', 'bearer', 'oauth2', 'aws_sigv4'));
