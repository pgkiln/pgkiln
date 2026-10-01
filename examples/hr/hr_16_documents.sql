-- =====================================================================
-- HR sample, part 16: several files per upload item (see docs/guide/16-files.md)
--
--   * hr.emp_document: an employee's documents (contract, certificates),
--     one row per file, deleted with the employee
--   * row level security: employees see their own documents, managers
--     their team's, administrators all
--   * "Documents" on the employee form: a file item with "multiple" that
--     saves every chosen file as a row of hr.emp_document
-- =====================================================================

create table hr.emp_document (
  id          bigint generated always as identity primary key,
  empno       int    not null references hr.emp on delete cascade,
  filename    text   not null,
  mime_type   text   not null,
  content     bytea  not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by text   not null default meta.app_user(),
  constraint emp_document_size check (octet_length(content) <= 5 * 1024 * 1024)
);
create index on hr.emp_document (empno);

grant select, insert, delete on hr.emp_document to hr_app;

alter table hr.emp_document enable row level security;
create policy document_visible on hr.emp_document for select
  using (empno = hr.current_empno() or hr.is_manager_of(empno) or meta.has_role('admin'));
create policy document_insert on hr.emp_document for insert
  with check (hr.is_manager_of(empno) or meta.has_role('admin'));
create policy document_delete on hr.emp_document for delete
  using (hr.is_manager_of(empno) or meta.has_role('admin'));

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, help, config)
select p.id, r.id, 120, 'P3_DOCUMENTS', 'Documents', 'file', 'content',
       'PDF, Word, Excel or image files of at most 5 MB each.',
       '{"multiple": true, "max_files": 5, "wide": true, "max_mb": 5, "table": "hr.emp_document", "parent_column": "empno", "key_column": "id",
         "filename_column": "filename", "mime_column": "mime_type",
         "accept": ".pdf,.doc,.docx,.xls,.xlsx,.odt,.ods,image/png,image/jpeg,image/webp"}'
  from meta.page p
  join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 3;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Documents', 'Documenten'),
  ('PDF, Word, Excel or image files of at most 5 MB each.', 'PDF-, Word-, Excel- of afbeeldingsbestanden van maximaal 5 MB per stuk.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
