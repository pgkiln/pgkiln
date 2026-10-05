-- HR page 13 (Import employees) takes XML files too (sprint 31): rows are the
-- repeating element, columns its child elements and attributes, matched to
-- the table columns by name. The application also gets a data load definition
-- for XML files of employees (SQL Workshop -> Load Data can use it, and so can
-- a data_load process: {"file_item": "P13_FILE", "definition": "EMP_XML"}):
-- values are trimmed and upper-cased, the hire date has a format.
update meta.item i set config = config || '{"accept": ".csv,.tsv,.txt,.xlsx,.json,.xml"}', help = 'CSV, TSV, .xlsx, JSON or XML, at most 5 MB.'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 13 and i.name = 'P13_FILE';

update meta.region r set source = replace(r.source,
         '<p><a href="/static/samples/employees.csv" download>Download an example file</a></p>',
         '<p><a href="/static/samples/employees.csv" download>Download an example file</a> (or <a href="/static/samples/employees.xml" download>as XML</a>).</p>')
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 13;

insert into meta.data_load_def (app_id, name, description, table_name, format, row_tag, mode, columns)
select a.id, 'EMP_XML', 'Employees from an XML file like /static/samples/employees.xml into hr.emp (merged by empno).',
       'hr.emp', 'xml', 'employee', 'merge',
       '[{"source": "@empno", "column": "empno"},
         {"source": "ename", "column": "ename", "transform": ["collapse_spaces", "upper"]},
         {"source": "job", "column": "job", "transform": ["trim", "upper"]},
         {"source": "mgr", "column": "mgr"},
         {"source": "hiredate", "column": "hiredate", "format": "YYYY-MM-DD"},
         {"source": "sal", "column": "sal", "default": "0"},
         {"source": "comm", "column": "comm"},
         {"source": "deptno", "column": "deptno"}]'
  from meta.app a where a.alias = 'hr';
