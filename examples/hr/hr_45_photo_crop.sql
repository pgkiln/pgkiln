-- =====================================================================
-- HR example, part 45: cropping a photo before upload
-- (docs/guide/16-files.md, "Cropping pictures")
--
-- The employee photo (P3_PHOTO) is cropped to a square in the browser
-- before it is uploaded; the item keeps its other settings (max_px, …).
-- =====================================================================

update meta.item i set config = coalesce(i.config, '{}'::jsonb) || '{"crop": "1:1"}'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 3 and i.name = 'P3_PHOTO';
