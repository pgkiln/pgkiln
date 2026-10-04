-- More item types (APEX: Rich Text Editor, Markdown Editor, Star Rating, Combobox, date range, QR Code)
--   richtext   formatted text, stored as HTML rebuilt from an allow-list (src/richtext.ts)
--   markdown   Markdown text, shown as HTML from the same allow-list
--   rating     stars (radio buttons), stored as 1..max
--   combobox   free text with suggestions from the list of values; several values colon-separated
--   daterange  two dates stored as "from:to" (ISO dates, either may be empty)
--   qrcode     display only: the value drawn as a QR code (SVG, made on the server)
-- Password items take {"reveal": true} in their attributes (no schema change).
alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in
  ('text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display',
   'password', 'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location',
   'richtext', 'markdown', 'rating', 'combobox', 'daterange', 'qrcode'));
