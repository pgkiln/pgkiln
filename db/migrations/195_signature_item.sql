-- Sprint 239 (MG-12): the signature item type.
--
--   signature   a pad to sign on with a finger, a pen or the mouse (a <canvas>); the drawing is posted as a PNG and
--               becomes a temporary file of the session (meta.save_temp_file), like a file upload item's, so a form
--               region saves it into the item's bytea source column and a process reads it from meta.temp_files.
--               The runtime treats it as a file item that only takes PNG pictures (src/metadata.ts presetItem).

alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in (
  'text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display', 'password',
  'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location', 'richtext', 'markdown', 'rating',
  'combobox', 'daterange', 'qrcode', 'plugin', 'image', 'address', 'shuttle', 'select_one', 'select_many',
  'image_upload', 'percent_graph', 'display_map', 'autocomplete', 'signature'));
