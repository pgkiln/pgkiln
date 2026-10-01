-- =====================================================================
-- HR example, part 12: a Progressive Web App for work on the road
-- (docs/guide/17-mobile.md)
--
-- The app can be installed on a phone, shows pages opened before when
-- there's no connection, and keeps forms sent offline until the connection
-- is back (a leave request filed on the train). The employee form records a
-- work location from the phone's GPS and takes the photo with the camera.
-- =====================================================================
update meta.app set pwa = true, pwa_short_name = 'HR', pwa_offline_pages = true, pwa_offline_submit = true
 where alias = 'hr';

alter table hr.emp add column work_location text;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help)
select p.id, r.id, 105, 'P3_WORK_LOCATION', 'Work location', 'location', 'work_location',
       'Where this employee usually works; "Use my location" takes the phone''s position.'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3;

-- the photo: the phone's camera, made smaller before upload
update meta.item i set config = config || '{"capture": "environment", "max_px": 1200}'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 3 and i.name = 'P3_PHOTO';
