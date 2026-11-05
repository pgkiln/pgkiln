-- Sprint 158 (CD-5; APEX 26.2 page items): Image Upload, Percent Graph, Display Map and Text Field with autocomplete.
--
--   image_upload   a file item for pictures: image/* only, a preview, cropping (config "crop": free, 1:1, 4:3 …; default
--                  free) and a maximum size applied in the browser before upload ("max_px", default 1600); the column
--                  and file settings are a file item's
--   percent_graph  display only: a 0–100 value as a bar (a <progress> element)
--   display_map    display only: a small map of "lat,lng" (the item's value, or config "coordinates_item") with a pin,
--                  from the map regions' tile server (MAP_TILE_URL); config "zoom" (default 15)
--   autocomplete   a text field with suggestions from the list of values; any text may be entered (a one-value combobox)

alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in (
  'text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display', 'password',
  'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location', 'richtext', 'markdown', 'rating',
  'combobox', 'daterange', 'qrcode', 'plugin', 'image', 'address', 'shuttle', 'select_one', 'select_many',
  'image_upload', 'percent_graph', 'display_map', 'autocomplete'));
