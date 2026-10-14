-- =====================================================================
-- 097: generated applications read like APEX's (sprint 71)
--
-- - meta.wizard_label(name): human labels. snake_case and camelCase are
--   split, run-together words are segmented with a small word list
--   (hiredate → Hire Date, deptno → Department Number) and common
--   abbreviations are expanded (emp → Employee, sal → Salary, qty →
--   Quantity, crm → CRM).
-- - meta.wizard_table_label(table, plural) and
--   meta.wizard_column_label(table, column): a short COMMENT ON wins; a
--   foreign key column drops its _id/no suffix (deptno → Department), a
--   column that repeats the table's first letter drops it (emp.ename →
--   Name). Listing pages and navigation use the plural (Employees), forms
--   and dialog titles the singular (Employee).
-- - meta.wizard_files(table): a bytea column and the columns that go with
--   it (<col>_name, <col>_mime, <col>_size, <col>_updated, or filename and
--   mime_type next to the only bytea column). Forms get one file item bound
--   to all of them; reports leave them out.
-- - meta.wizard_report(table, columns): a report query that joins each
--   foreign key to its parent and shows the parent's display column (the
--   key itself stays, hidden), with headings and number format masks.
-- - meta.wizard_report_form(...): the "report and form" pages of the
--   wizards (meta.generate_page 'report_form'), an edit icon per row.
--   meta.generate_crud is unchanged (scripts that call it keep their pages).
-- - meta.wizard_form, meta.wizard_defaults and meta.generate_page use the
--   labels; charts label rows without a value "(none)".
-- =====================================================================

-- ---------------------------------------------------------------- words
-- abbreviations and the words they stand for (lowercase key → label)
create function meta.wizard_abbreviations() returns jsonb
language sql immutable as $$
  select '{
    "emp": "Employee", "empl": "Employee", "dept": "Department", "sal": "Salary", "comm": "Commission",
    "mgr": "Manager", "no": "Number", "num": "Number", "nr": "Number", "qty": "Quantity", "desc": "Description",
    "descr": "Description", "pct": "Percent", "perc": "Percent", "amt": "Amount", "addr": "Address",
    "tel": "Telephone", "cust": "Customer", "prod": "Product", "cat": "Category", "org": "Organization",
    "loc": "Location", "dt": "Date", "ts": "Timestamp", "cnt": "Count", "img": "Image", "msg": "Message",
    "seq": "Sequence", "ref": "Reference", "req": "Request", "acct": "Account", "avg": "Average",
    "yr": "Year", "dob": "Date of Birth", "id": "ID", "ids": "IDs", "url": "URL", "uri": "URI", "api": "API",
    "crm": "CRM", "sku": "SKU", "vat": "VAT", "ip": "IP", "uuid": "UUID", "html": "HTML", "pdf": "PDF",
    "sms": "SMS", "iban": "IBAN", "bic": "BIC", "hr": "HR", "faq": "FAQ", "kpi": "KPI", "eta": "ETA",
    "iso": "ISO", "utc": "UTC", "gps": "GPS", "lat": "Latitude", "lng": "Longitude", "lon": "Longitude",
    "hiredate": "Hire Date", "username": "Username", "email": "Email"
  }'::jsonb
$$;

-- words that may be run together in a column name (hire + date)
create function meta.wizard_is_word(p_word text) returns boolean
language sql immutable as $$
  select p_word = any ('{
    name,first,last,middle,full,user,created,updated,modified,deleted,changed,at,by,on,start,end,time,birth,code,
    type,status,total,price,unit,order,line,item,phone,mail,address,city,zip,postal,country,state,region,amount,
    count,rate,level,group,role,title,note,notes,key,value,number,date,day,month,year,week,hour,size,weight,height,
    width,length,color,flag,is,has,active,valid,from,to,due,paid,sent,received,open,closed,parent,child,owner,
    manager,employee,department,customer,product,category,invoice,payment,account,project,task,job,salary,
    commission,location,description,comment,quantity,percent,image,photo,file,mime,content,short,long,login,
    password,hash,sort,display,label,version,until,effective,approved,reviewed,score,rating,grade,stock,cost,
    budget,tax,discount,sales,hire,leave,request,review,event,visit,contact,policy,audit,log,station,reading,
    work,home,mobile,fax,web,site,page,link,source,target,max,min,fee,net,gross,currency,lang,language,text,
    body,subject,message,author,editor,client,vendor,supplier,team,member,person,company,street,house,expiry,
    expires,valid,last,next,prev,previous,lead,deal,stage,priority,severity,step,plan,actual,estimate,percent
  }'::text[])
$$;

-- one lowercase word as a label: an abbreviation, a known word, or known words run together
create function meta.wizard_word(p_word text) returns text
language plpgsql immutable as $$
declare
  v_abbr jsonb := meta.wizard_abbreviations();
  n      int := length(p_word);
  v_best text[];
  v_cnt  int[];
  v_piece text;
begin
  if p_word is null or p_word = '' then
    return p_word;
  end if;
  if v_abbr ? p_word then
    return v_abbr ->> p_word;
  end if;
  if p_word ~ '^[0-9]+$' or meta.wizard_is_word(p_word) or n > 40 then
    return initcap(p_word);
  end if;
  -- the fewest known pieces (two letters or more) that make up the word
  v_best := array_fill(null::text, array[n + 1], array[0]);
  v_cnt := array_fill(null::int, array[n + 1], array[0]);
  v_best[0] := '';
  v_cnt[0] := 0;
  for i in 2..n loop
    for j in 0..i - 2 loop
      continue when v_cnt[j] is null;
      v_piece := substr(p_word, j + 1, i - j);
      if (v_abbr ? v_piece or meta.wizard_is_word(v_piece)) and (v_cnt[i] is null or v_cnt[j] + 1 < v_cnt[i]) then
        v_cnt[i] := v_cnt[j] + 1;
        v_best[i] := v_best[j] || case when j > 0 then ' ' else '' end || coalesce(v_abbr ->> v_piece, initcap(v_piece));
      end if;
    end loop;
  end loop;
  if v_cnt[n] >= 2 then
    return v_best[n];
  end if;
  return initcap(p_word);
end
$$;

-- a label from a name: order_date → Order Date, hiredate → Hire Date, unitPrice → Unit Price, emp → Employee
create or replace function meta.wizard_label(p_name text) returns text
language sql immutable as $$
  select string_agg(meta.wizard_word(w), ' ' order by n)
    from regexp_split_to_table(
           lower(regexp_replace(regexp_replace(regexp_replace(btrim(p_name), '([a-z0-9])([A-Z])', '\1_\2', 'g'),
                                               '([A-Z]+)([A-Z][a-z])', '\1_\2', 'g'),
                                '([A-Za-z])([0-9])', '\1_\2', 'g')),
           '[^a-z0-9]+') with ordinality x(w, n)
   where w <> ''
$$;

-- words that have no plural
create function meta.wizard_uncountable(p_word text) returns boolean
language sql immutable as $$
  select lower(p_word) = any ('{staff,data,metadata,information,info,equipment,news,feedback,software,hardware,media,
                                series,species,personnel,sheep,fish,money,research,advice,furniture,luggage,traffic}'::text[])
$$;

-- the plural of a label's last word: Employee → Employees, Policy → Policies, Status → Statuses
create function meta.wizard_plural(p_label text) returns text
language plpgsql immutable as $$
declare
  v_last text := substring(p_label from '([A-Za-z]+)$');
  v_head text;
  l      text;
begin
  if v_last is null or meta.wizard_uncountable(v_last) or v_last ~ '^[A-Z]+$' then
    return p_label;
  end if;
  v_head := left(p_label, length(p_label) - length(v_last));
  l := lower(v_last);
  if l = 'person' then
    return v_head || left(v_last, 1) || 'eople';
  elsif l = 'child' then
    return v_head || v_last || 'ren';
  elsif l ~ '[^aeiou]y$' then
    return v_head || left(v_last, -1) || 'ies';
  elsif l ~ '(ss|us|x|z|ch|sh)$' then
    return v_head || v_last || 'es';
  elsif l ~ 's$' then
    -- a plural already
    return p_label;
  end if;
  return v_head || v_last || 's';
end
$$;

-- the singular of a label's last word: Employees → Employee, Categories → Category
create function meta.wizard_singular(p_label text) returns text
language plpgsql immutable as $$
declare
  v_last text := substring(p_label from '([A-Za-z]+)$');
  v_head text;
  l      text;
begin
  if v_last is null or meta.wizard_uncountable(v_last) or v_last ~ '^[A-Z]+$' then
    return p_label;
  end if;
  v_head := left(p_label, length(p_label) - length(v_last));
  l := lower(v_last);
  if l = 'people' then
    return v_head || left(v_last, 1) || 'erson';
  elsif l = 'children' then
    return v_head || left(v_last, -3);
  elsif l ~ '[^aeiou]ies$' then
    return v_head || left(v_last, -3) || 'y';
  elsif l ~ '(ss|us|is)$' then
    return p_label;
  elsif l ~ '(sses|xes|zes|ches|shes|uses)$' then
    return v_head || left(v_last, -2);
  elsif l ~ 's$' then
    return v_head || left(v_last, -1);
  end if;
  return p_label;
end
$$;

-- a comment short enough to be a label (one line), else null
create function meta.wizard_short(p_text text, p_max int) returns text
language sql immutable as $$
  select case when btrim(p_text) <> '' and length(btrim(p_text)) <= p_max and btrim(p_text) !~ '[\r\n]' and btrim(p_text) !~ '\.$'
              then btrim(p_text) end
$$;

-- a table's label: its short comment, or its name as words (a view's _v suffix left out), plural or singular
create function meta.wizard_table_label(p_table regclass, p_plural boolean default true) returns text
language plpgsql stable as $$
declare
  v_comment text := meta.wizard_short(obj_description(p_table, 'pg_class'), 40);
  v_rel     text := (select relname from pg_class where oid = p_table);
  v_label   text;
begin
  if v_comment is not null then
    return v_comment;
  end if;
  v_label := meta.wizard_label(coalesce(nullif(regexp_replace(v_rel, '(_v|_vw|_view)$|^(v|vw)_', '', 'i'), ''), v_rel));
  return case when p_plural then meta.wizard_plural(meta.wizard_singular(v_label)) else meta.wizard_singular(v_label) end;
end
$$;

-- a column's label: its short comment; a foreign key without its _id/no suffix; emp.ename → Name
create function meta.wizard_column_label(p_table regclass, p_col text) returns text
language plpgsql stable as $$
declare
  v_comment text;
  v_rel     text := lower((select relname from pg_class where oid = p_table));
  v_fk      boolean;
  v_pk      boolean;
  v_base    text := p_col;
  v_rest    text;
  l         text := lower(p_col);
begin
  select meta.wizard_short(col_description(p_table, a.attnum), 60) into v_comment
    from pg_attribute a where a.attrelid = p_table and a.attname = p_col and not a.attisdropped;
  if v_comment is not null then
    return v_comment;
  end if;
  select c.fk_table is not null, c.is_pk into v_fk, v_pk from meta.wizard_catalog(p_table) c where c.column_name = p_col;
  if v_fk and not v_pk then
    v_rest := regexp_replace(p_col, '_?(id|no|num|nr|code|key|fk)$', '', 'i');
    if length(v_rest) >= 2 then
      v_base := v_rest;
    end if;
  elsif length(l) >= 4 and left(l, 1) = left(v_rel, 1) and not (meta.wizard_abbreviations() ? l) and not meta.wizard_is_word(l)
        and meta.wizard_is_word(substr(l, 2)) then
    -- a column named after the table's first letter: ename, dname
    v_base := substr(p_col, 2);
  end if;
  return meta.wizard_label(v_base);
end
$$;

-- ---------------------------------------------------------------- files
-- the bytea columns of a table and the columns that hold their file name, mime type, size and change time
create function meta.wizard_files(p_table regclass)
returns table (column_name text, name_column text, mime_column text, size_column text, updated_column text)
language sql stable as $$
  with c as (select * from meta.wizard_catalog(p_table)),
       b as (select c.column_name from c where c.kind = 'binary'),
       one as (select count(*) = 1 as one from b)
  select b.column_name,
         (select x.column_name from c x
           where x.kind = 'text' and (x.column_name = any (array[b.column_name || '_name', b.column_name || '_filename', b.column_name || '_file_name', b.column_name || 'name'])
                                      or ((select one from one) and x.column_name in ('filename', 'file_name')))
           order by x.ordinal limit 1),
         (select x.column_name from c x
           where x.kind = 'text' and (x.column_name = any (array[b.column_name || '_mime', b.column_name || '_mimetype', b.column_name || '_mime_type', b.column_name || '_content_type', b.column_name || '_type'])
                                      or ((select one from one) and x.column_name in ('mime_type', 'mimetype', 'content_type')))
           order by x.ordinal limit 1),
         (select x.column_name from c x
           where x.kind = 'number' and (x.column_name = any (array[b.column_name || '_size', b.column_name || '_length', b.column_name || '_bytes'])
                                        or ((select one from one) and x.column_name in ('file_size', 'filesize')))
           order by x.ordinal limit 1),
         (select x.column_name from c x
           where x.kind in ('date', 'timestamp') and x.column_name = any (array[b.column_name || '_updated', b.column_name || '_updated_at', b.column_name || '_last_updated', b.column_name || '_lastupd', b.column_name || '_changed_at'])
           order by x.ordinal limit 1)
    from b
$$;

-- the columns that go with a file column (left out of reports and forms: the file item fills them)
create function meta.wizard_sidecars(p_table regclass) returns text[]
language sql stable as $$
  select coalesce(array_agg(x) filter (where x is not null), '{}')
    from meta.wizard_files(p_table) f, unnest(array[f.name_column, f.mime_column, f.size_column, f.updated_column]) x
$$;

-- ---------------------------------------------------------------- formats
-- a number column's format mask: group separators, the scale's decimals (keys get none)
create function meta.wizard_mask(p_type_sql text, p_kind text, p_key boolean) returns text
language sql immutable as $$
  select case
           when p_kind <> 'number' or p_key then null
           when p_type_sql ~ '^numeric\(\d+,[1-9]\d*\)$'
             then '999G999G999G990D' || repeat('0', least(substring(p_type_sql from ',(\d+)\)')::int, 6))
           when p_type_sql in ('smallint', 'integer', 'bigint') or p_type_sql ~ '^numeric\(\d+(,0)?\)$' then '999G999G999G990'
         end
$$;

-- ---------------------------------------------------------------- reports
-- a report on a table: each foreign key shows its parent's display column (the key itself is hidden),
-- file columns are left out; {"source", "hidden", "headings", "formats"}
create function meta.wizard_report(p_table regclass, p_columns text[] default null) returns jsonb
language plpgsql stable as $$
declare
  v_skip   text[] := meta.wizard_sidecars(p_table);
  v_taken  text[] := (select array_agg(column_name) from meta.wizard_catalog(p_table));
  v_cols   text[] := '{}';
  v_joins  text := '';
  v_hidden text[] := '{}';
  v_head   jsonb := '{}';
  v_fmt    jsonb := '{}';
  v_n      int := 0;
  v_name   text;
  v_mask   text;
  c        record;
begin
  for c in select * from meta.wizard_catalog(p_table) order by ordinal loop
    continue when c.kind in ('binary', 'geometry') or c.column_name = any (v_skip);
    continue when p_columns is not null and not c.is_pk and not (c.column_name = any (p_columns));
    if c.fk_display is not null and c.fk_display <> c.fk_column and not c.is_pk then
      v_n := v_n + 1;
      v_name := c.column_name || '_display';
      while v_name = any (v_taken) loop
        v_name := v_name || '_';
      end loop;
      v_taken := v_taken || v_name;
      v_joins := v_joins || format(E'\n  left join %s p%s on p%s.%I = t.%I', meta.wizard_qname(c.fk_table), v_n, v_n, c.fk_column, c.column_name);
      v_cols := v_cols || format('t.%I', c.column_name) || format('p%s.%I as %I', v_n, c.fk_display, v_name);
      v_hidden := v_hidden || c.column_name;
      v_head := v_head || jsonb_build_object(v_name, meta.wizard_column_label(p_table, c.column_name));
    else
      v_cols := v_cols || format('t.%I', c.column_name);
      v_head := v_head || jsonb_build_object(c.column_name, meta.wizard_column_label(p_table, c.column_name));
      v_mask := meta.wizard_mask(c.type_sql, c.kind, c.is_pk or c.fk_table is not null);
      if v_mask is not null then
        v_fmt := v_fmt || jsonb_build_object(c.column_name, v_mask);
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'source', format(E'select %s\n  from %s t%s', array_to_string(v_cols, E',\n       '), meta.wizard_qname(p_table), v_joins),
    'hidden', to_jsonb(v_hidden), 'headings', v_head, 'formats', v_fmt);
end
$$;

-- ---------------------------------------------------------------- defaults
create or replace function meta.wizard_defaults(p_kind text, p_table regclass) returns jsonb
language plpgsql stable as $$
declare
  v_pk      text := meta.wizard_pk(p_table);
  v_display text := meta.wizard_display(p_table);
  v_skip    text[] := meta.wizard_sidecars(p_table);
  v_fk      text;
  v_first   text;
  v_out     jsonb;
  v_start   text;
  v_detail  record;
begin
  -- the first foreign key column (not the key itself)
  select column_name into v_fk from meta.wizard_catalog(p_table)
   where fk_table is not null and not is_pk order by (fk_table = p_table), ordinal limit 1;
  v_out := jsonb_build_object('label', meta.wizard_table_label(p_table, p_kind <> 'form'), 'nav', p_kind <> 'form',
    'icon', case p_kind when 'form' then 'file' when 'cards' then 'layers' when 'calendar' then 'calendar'
                        when 'chart' then 'chart' when 'map' then 'map' when 'facets' then 'filter'
                        when 'grid' then 'grid' when 'master_detail' then 'grid' else 'table' end);
  case p_kind
  when 'report_form', 'grid' then
    null;
  when 'form' then
    v_out := v_out || jsonb_build_object('mode', 'normal', 'return_page', null,
      'columns', (select jsonb_agg(column_name order by ordinal) from meta.wizard_catalog(p_table)
                   where not generated and not (column_name = any (v_skip))));
  when 'cards' then
    v_first := coalesce(v_display, v_pk);
    v_out := v_out || jsonb_build_object('title', v_first,
      'subtitle', coalesce(v_fk, (select column_name from meta.wizard_catalog(p_table)
                                   where kind = 'text' and not is_pk and column_name is distinct from v_first
                                     and not (column_name = any (v_skip)) order by ordinal limit 1)),
      'body', (select column_name from meta.wizard_catalog(p_table)
                where kind = 'text' and not is_pk and fk_table is null and column_name is distinct from v_first
                  and column_name is distinct from v_fk and not (column_name = any (v_skip))
                  and column_name is distinct from (select column_name from meta.wizard_catalog(p_table)
                                                     where kind = 'text' and not is_pk and column_name is distinct from v_first
                                                       and not (column_name = any (v_skip)) order by ordinal limit 1)
                order by ordinal limit 1),
      'badge', null, 'form_page', null);
  when 'calendar' then
    select column_name into v_start from meta.wizard_catalog(p_table)
     where kind in ('date', 'timestamp') and not (column_name = any (v_skip))
     order by (column_name ~ '(start|begin|from|^date|_date$|_at$|_on$)') desc,
              (column_name ~ '(created|updated|modified|changed)') asc, ordinal
     limit 1;
    v_out := v_out || jsonb_build_object('start', v_start,
      'end', (select column_name from meta.wizard_catalog(p_table)
               where kind in ('date', 'timestamp') and column_name is distinct from v_start
                 and column_name ~ '(end|until|finish|stop|^to_|_to$)'
               order by ordinal limit 1),
      'title', coalesce((select column_name from meta.wizard_catalog(p_table)
                          where kind = 'text' and not is_pk and column_name ~ '(name|title|label|subject|summary)'
                            and not (column_name = any (v_skip))
                          order by ordinal limit 1), v_fk, v_display, v_pk),
      'drag', false, 'form_page', null);
  when 'chart' then
    v_out := v_out || jsonb_build_object('chart', 'bar',
      'label_column', coalesce(v_fk,
        (select column_name from meta.wizard_catalog(p_table) where kind = 'text' and not is_pk and not is_unique
            and not (column_name = any (v_skip)) order by ordinal limit 1),
        (select column_name from meta.wizard_catalog(p_table) where kind in ('text', 'boolean', 'date') and not is_pk
            and not (column_name = any (v_skip)) order by ordinal limit 1),
        v_pk),
      'function', 'count', 'value_column', null);
  when 'map' then
    v_out := v_out || jsonb_build_object(
      'location', (select column_name from meta.wizard_catalog(p_table)
                    where kind in ('geometry', 'point') or (kind = 'text' and column_name like '%location%')
                    order by (kind = 'geometry') desc, (kind = 'point') desc, ordinal limit 1),
      'lat', (select column_name from meta.wizard_catalog(p_table)
               where kind = 'number' and column_name ~ '^(lat|latitude)$|_lat$|_latitude$|^lat_' order by ordinal limit 1),
      'lng', (select column_name from meta.wizard_catalog(p_table)
               where kind = 'number' and column_name ~ '^(lng|lon|long|longitude)$|_(lng|lon|long|longitude)$|^(lng|lon)_' order by ordinal limit 1),
      'title', coalesce(v_display, v_pk),
      'body', (select column_name from meta.wizard_catalog(p_table)
                where kind = 'text' and not is_pk and column_name is distinct from v_display
                  and column_name not like '%location%' and not (column_name = any (v_skip)) order by ordinal limit 1),
      'report', true, 'form_page', null);
    -- a pair of coordinates wins over a text location
    if v_out ->> 'lat' is not null and v_out ->> 'lng' is not null
       and not exists (select 1 from meta.wizard_catalog(p_table) where column_name = v_out ->> 'location' and kind in ('geometry', 'point')) then
      v_out := v_out || '{"location": null}';
    end if;
  when 'facets' then
    v_out := v_out || jsonb_build_object('search', true, 'form_page', null,
      'columns', (select jsonb_agg(column_name order by ordinal) from meta.wizard_catalog(p_table)
                   where kind not in ('binary', 'geometry') and not (column_name = any (v_skip))),
      'facets', coalesce((select jsonb_agg(column_name order by rank, ordinal) from (
          select column_name, ordinal,
                 case when fk_table is not null then 1 when kind = 'boolean' then 2 when kind = 'text' then 3
                      when kind in ('date', 'timestamp') then 4 else 5 end as rank
            from meta.wizard_catalog(p_table)
           where not is_pk and not is_unique and column_name is distinct from v_display and not (column_name = any (v_skip))
             and (fk_table is not null
                  or kind = 'boolean'
                  -- text with few values (statistics), or, without statistics, not a free text by its name
                  or (kind = 'text' and (distinct_values between 1 and 50
                                         or (distinct_values is null and column_name !~ '(note|descr|comment|remark|body|text|address|mail|url|phone|summary|password|hash|token)')))
                  or kind in ('date', 'timestamp')
                  or (kind = 'number' and column_name !~ '(^|_)(id|no|lat|lng|lon|latitude|longitude)$'))
           order by rank, ordinal limit 6) f), '[]'));
  when 'master_detail' then
    -- the first table with a foreign key to this table's key
    select con.conrelid::regclass as detail, a.attname::text as col into v_detail
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.confrelid = p_table and con.contype = 'f' and con.conrelid <> p_table
       and array_length(con.conkey, 1) = 1
       and con.confkey[1] = (select ordinal from meta.wizard_catalog(p_table) where is_pk)
     order by con.conrelid::regclass::text, con.conname
     limit 1;
    v_out := v_out || jsonb_build_object('detail', meta.wizard_qname(v_detail.detail), 'detail_column', v_detail.col,
      'label', meta.wizard_table_label(p_table) || coalesce(' and ' || meta.wizard_table_label(v_detail.detail), ''));
  else
    raise exception 'unknown page type "%"', p_kind;
  end case;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- forms
-- a form page for one row of a table (the form of "report and form", or the form only page)
create or replace function meta.wizard_form(
  p_app meta.app, p_table regclass, p_page int, p_label text, p_return int, p_modal boolean, p_columns text[] default null
) returns int
language plpgsql as $$
declare
  v_pk      text := meta.wizard_pk(p_table);
  v_skip    text[] := meta.wizard_sidecars(p_table);
  v_pk_item text;
  v_page    int;
  v_region  int;
  v_seq     int := 10;
  v_type    text;
  v_lov     text;
  v_cfg     jsonb;
  v_help    text;
  f         record;
  c         record;
begin
  if v_pk is null then
    raise exception 'a form needs a table with a single-column primary key (% has none)', p_table;
  end if;
  v_pk_item := meta.wizard_item(p_page, v_pk);
  v_page := meta.wizard_new_page(p_app, p_page, case when p_modal then p_label || ' Form' else p_label end,
                                 coalesce(p_return, p_app.home_page), case when p_modal then 'modal' else 'normal' end);
  update meta.page set title = p_label where id = v_page;
  insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item, template)
  values (v_page, 10, p_label, 'form', meta.wizard_qname(p_table), v_pk, v_pk_item, case when p_modal then 'plain' else 'standard' end)
  returning id into v_region;

  for c in select * from meta.wizard_catalog(p_table) order by ordinal loop
    continue when c.generated and not c.is_pk;
    -- the file item fills these
    continue when c.column_name = any (v_skip);
    -- left out by the developer, unless the row can't be saved without it
    continue when p_columns is not null and not c.is_pk and not (c.column_name = any (p_columns))
              and not (c.not_null and not c.has_default);
    v_lov := null;
    v_cfg := '{}';
    v_type := case
      when c.is_pk                   then 'hidden'
      when c.fk_table is not null    then 'select'
      when c.kind = 'binary'         then 'file'
      when c.kind = 'number'         then 'number'
      when c.kind = 'date'           then 'date'
      when c.kind = 'timestamp'      then 'datetime'
      when c.kind = 'boolean'        then 'switch'
      when c.kind = 'point'          then 'text'
      else 'text'
    end;
    if v_type = 'select' then
      v_lov := format('select %I as d, %I as r from %s order by 1', coalesce(c.fk_display, c.fk_column), c.fk_column, meta.wizard_qname(c.fk_table));
    elsif v_type = 'file' then
      select * into f from meta.wizard_files(p_table) x where x.column_name = c.column_name;
      v_cfg := jsonb_strip_nulls(jsonb_build_object('filename_column', f.name_column, 'mime_column', f.mime_column,
        'size_column', f.size_column, 'updated_column', f.updated_column,
        'accept', case when c.column_name ~* '(photo|image|picture|avatar|logo|thumbnail|portrait)' then 'image/*' end));
    elsif v_type = 'number' then
      v_cfg := jsonb_strip_nulls(jsonb_build_object('format_mask', meta.wizard_mask(c.type_sql, c.kind, false)));
    end if;
    -- a longer column comment is the item's help text
    v_help := (select btrim(col_description(p_table, a.attnum)) from pg_attribute a where a.attrelid = p_table and a.attname = c.column_name);
    if meta.wizard_short(v_help, 60) is not null or v_help = '' then
      v_help := null;
    end if;
    insert into meta.item (page_id, region_id, seq, name, label, type, lov, source_column, required, config, help)
    values (v_page, v_region, v_seq, meta.wizard_item(p_page, c.column_name), meta.wizard_column_label(p_table, c.column_name),
            v_type, v_lov, c.column_name, c.not_null and not c.has_default and not c.is_pk and v_type <> 'switch', v_cfg, v_help);
    v_seq := v_seq + 10;
  end loop;

  insert into meta.button (page_id, region_id, seq, name, label, action, target_page, condition, hot, confirm) values
    (v_page, v_region, 10, 'CANCEL', 'Cancel', 'redirect', coalesce(p_return, p_app.home_page, p_page), null, false, null),
    (v_page, v_region, 20, 'DELETE', 'Delete', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is not null', v_pk_item), false, 'Delete this record?'),
    (v_page, v_region, 30, 'SAVE', 'Apply Changes', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is not null', v_pk_item), true, null),
    (v_page, v_region, 40, 'CREATE', 'Create', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is null', v_pk_item), true, null);
  insert into meta.process (page_id, seq, name, type, region_id)
  values (v_page, 10, 'Process form ' || p_label, 'form_dml', v_region);
  return v_page;
end
$$;

-- an interactive report of a table with an edit icon per row, its modal form and a Create button
create function meta.wizard_report_form(
  p_app meta.app, p_table regclass, p_page int, p_form int, p_label text, p_form_label text
) returns int
language plpgsql as $$
declare
  v_pk     text := meta.wizard_pk(p_table);
  v_rep    jsonb := meta.wizard_report(p_table);
  v_page   int;
  v_region int;
begin
  if v_pk is null then
    raise exception 'a report and form needs a table with a single-column primary key (% has none)', p_table;
  end if;
  if p_form is null then
    raise exception 'a report and form needs a form page number';
  end if;
  v_page := meta.wizard_new_page(p_app, p_page, p_label, p_app.home_page);
  insert into meta.region (page_id, seq, title, type, source, config)
  values (v_page, 10, p_label, 'report', v_rep ->> 'source',
          jsonb_build_object('link', jsonb_build_object('column', v_pk, 'page', p_form, 'icon', true,
                                                        'items', jsonb_build_object(meta.wizard_item(p_form, v_pk), '#' || v_pk || '#')),
                             'headings', v_rep -> 'headings')
          || case when jsonb_array_length(v_rep -> 'hidden') > 0 then jsonb_build_object('hidden', v_rep -> 'hidden') else '{}' end
          || case when v_rep -> 'formats' <> '{}' then jsonb_build_object('formats', v_rep -> 'formats') else '{}' end)
  returning id into v_region;
  insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
  values (v_page, v_region, 10, 'CREATE', 'Create', 'redirect', p_form, true);
  perform meta.wizard_form(p_app, p_table, p_form, p_form_label, p_page, true, null);
  return v_page;
end
$$;

-- ---------------------------------------------------------------- generator
create or replace function meta.generate_page(
  p_app     text,
  p_kind    text,
  p_table   regclass,
  p_page    int,
  p_options jsonb default '{}'
) returns int
language plpgsql as $$
declare
  v_app     meta.app;
  o         jsonb;
  v_label   text;
  v_flabel  text;
  v_icon    text;
  v_pk      text := meta.wizard_pk(p_table);
  v_page    int;
  v_region  int;
  v_report  int;
  v_form    int;
  v_fpage   int;
  v_link    jsonb;
  v_cols    text;
  v_heads   jsonb := '{}';
  v_src     text;
  v_cfg     jsonb;
  v_a       text;
  v_b       text;
  v_c       text;
  v_d       text;
  v_kind    text;
  v_detail  regclass;
  v_dpk     text;
  v_item    text;
  v_facets  jsonb := '[]';
  v_geo     text;
  v_key     text;
  v_skip    text[] := meta.wizard_sidecars(p_table);
  c         record;
begin
  select * into v_app from meta.app where alias = p_app;
  if v_app.id is null then
    raise exception 'application "%" does not exist', p_app;
  end if;
  if p_kind not in ('report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail') then
    raise exception 'unknown page type "%"', p_kind;
  end if;
  -- the application's own data: not pgkiln's or the system's tables
  if (select n.nspname ~ '^pg_' or n.nspname in ('information_schema', 'meta')
        from pg_class rel join pg_namespace n on n.oid = rel.relnamespace where rel.oid = p_table) then
    raise exception 'pages can''t be generated on %', p_table;
  end if;
  if (select relkind from pg_class where oid = p_table) not in ('r', 'p', 'v', 'm') then
    raise exception '% is not a table or view', p_table;
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'object' then
    p_options := '{}';
  end if;
  -- an option given as JSON null or '' means "none"; a missing one takes the default
  o := meta.wizard_defaults(p_kind, p_table) || p_options;
  v_label := coalesce(nullif(btrim(o ->> 'label'), ''), meta.wizard_table_label(p_table, p_kind <> 'form'));
  -- (097) a form page of a listing is titled with the singular: Employees → Employee
  v_flabel := coalesce(nullif(btrim(o ->> 'form_label'), ''), meta.wizard_table_label(p_table, false));
  v_icon := nullif(o ->> 'icon', '');
  v_fpage := nullif(o ->> 'form_page', '')::int;
  if v_fpage = p_page then
    raise exception 'the form page needs a page number of its own';
  end if;

  if p_kind = 'report_form' then
    v_page := meta.wizard_report_form(v_app, p_table, p_page, v_fpage, v_label, v_flabel);
  elsif p_kind = 'grid' then
    perform meta.generate_grid(p_app, p_table, p_page, v_label, coalesce(v_icon, 'grid'));
    return (select id from meta.page where app_id = v_app.id and page_no = p_page);
  elsif p_kind = 'form' then
    v_page := meta.wizard_form(v_app, p_table, p_page, v_label, nullif(o ->> 'return_page', '')::int, o ->> 'mode' = 'modal',
      case when jsonb_typeof(o -> 'columns') = 'array'
           then (select array_agg(meta.wizard_col(p_table, x, 'form column')) from jsonb_array_elements_text(o -> 'columns') x) end);
  elsif p_kind = 'master_detail' then
    if v_pk is null then
      raise exception 'the master table % needs a single-column primary key', p_table;
    end if;
    if nullif(o ->> 'detail', '') is null then
      raise exception 'no detail table: % has no table with a foreign key to it', p_table;
    end if;
    v_detail := (o ->> 'detail')::regclass;
    v_dpk := meta.wizard_pk(v_detail);
    if v_dpk is null then
      raise exception 'the detail table % needs a single-column primary key', v_detail;
    end if;
    v_a := meta.wizard_col(v_detail, o ->> 'detail_column', 'detail column');
    if v_a is null then
      raise exception 'choose the detail column that refers to the master row';
    end if;
    v_item := meta.wizard_item(p_page, v_pk);
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, config)
    values (v_page, 10, meta.wizard_table_label(p_table), 'grid', 12,
            format(E'select %s\n  from %s', (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                                              from meta.wizard_catalog(p_table) where kind <> 'binary' and not (column_name = any (v_skip))),
                   meta.wizard_qname(p_table)),
            meta.wizard_qname(p_table), v_pk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(p_table),
                               'select_row', jsonb_build_object('column', v_pk, 'item', v_item)))
    returning id into v_region;
    insert into meta.item (page_id, region_id, seq, name, label, type)
    values (v_page, v_region, 10, v_item, meta.wizard_column_label(p_table, v_pk), 'hidden');
    insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, config)
    values (v_page, 20, meta.wizard_table_label(v_detail), 'grid', 12,
            format(E'select %s\n  from %s\n where %I = :%s::%s',
                   (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                      from meta.wizard_catalog(v_detail) where kind <> 'binary' and column_name <> v_a
                       and not (column_name = any (meta.wizard_sidecars(v_detail)))),
                   meta.wizard_qname(v_detail), v_a, v_item, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_pk)),
            meta.wizard_qname(v_detail), v_dpk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(v_detail, v_a),
                               'master', jsonb_build_object('item', v_item, 'column', v_a)))
    returning id into v_report;
    insert into meta.process (page_id, seq, name, type, region_id) values
      (v_page, 10, 'Save ' || meta.wizard_table_label(p_table), 'grid_dml', v_region),
      (v_page, 20, 'Save ' || meta.wizard_table_label(v_detail), 'grid_dml', v_report);
  else
    -- the listing kinds, with an optional modal form page for a row
    if v_fpage is not null and v_pk is null then
      raise exception 'a form page needs a table with a single-column primary key (% has none)', p_table;
    end if;
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    v_key := case when v_pk is not null then format('t.%I', v_pk) end;
    if v_fpage is not null then
      v_link := jsonb_build_object('page', v_fpage, 'items', jsonb_build_object(meta.wizard_item(v_fpage, v_pk), '#' || v_pk || '#'));
    end if;

    if p_kind = 'cards' then
      v_a := meta.wizard_col(p_table, o ->> 'title', 'title column');
      v_b := meta.wizard_col(p_table, o ->> 'subtitle', 'subtitle column');
      v_c := meta.wizard_col(p_table, o ->> 'body', 'body column');
      v_d := meta.wizard_col(p_table, o ->> 'badge', 'badge column');
      if v_a is null then
        raise exception 'choose the column for the card titles';
      end if;
      v_src := concat_ws(E',\n       ',
        meta.wizard_expr(p_table, v_a) || ' as title',
        meta.wizard_expr(p_table, v_b) || ' as subtitle',
        meta.wizard_expr(p_table, v_c) || ' as body',
        meta.wizard_expr(p_table, v_d) || ' as badge',
        v_key);
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'cards', format(E'select %s\n  from %s t\n order by 1', v_src, meta.wizard_qname(p_table)),
              jsonb_strip_nulls(jsonb_build_object('link', v_link)))
      returning id into v_region;

    elsif p_kind = 'calendar' then
      v_a := meta.wizard_col(p_table, o ->> 'start', 'start column');
      v_b := meta.wizard_col(p_table, o ->> 'end', 'end column');
      v_c := meta.wizard_col(p_table, o ->> 'title', 'title column');
      if v_a is null or (select kind from meta.wizard_catalog(p_table) where column_name = v_a) not in ('date', 'timestamp') then
        raise exception 'a calendar needs a date or timestamp start column';
      end if;
      if v_b is not null and (select kind from meta.wizard_catalog(p_table) where column_name = v_b) not in ('date', 'timestamp') then
        raise exception 'the end column must be a date or timestamp';
      end if;
      v_src := concat_ws(E',\n       ',
        format('t.%I as start_date', v_a),
        case when v_b is not null then format('t.%I as end_date', v_b) end,
        coalesce(meta.wizard_expr(p_table, v_c), quote_literal(v_label)) || ' as title',
        v_key);
      v_cfg := jsonb_strip_nulls(jsonb_build_object('link', v_link, 'key', v_pk));
      if v_fpage is not null then
        v_cfg := v_cfg || jsonb_build_object('create', jsonb_build_object('page', v_fpage, 'items',
          jsonb_strip_nulls(jsonb_build_object(meta.wizard_item(v_fpage, v_a), '#start#')
            || case when v_b is not null then jsonb_build_object(meta.wizard_item(v_fpage, v_b), '#end#') else '{}' end)));
      end if;
      if coalesce((o ->> 'drag')::boolean, false) then
        if v_pk is null then
          raise exception 'drag and drop needs a table with a single-column primary key (% has none)', p_table;
        end if;
        v_cfg := v_cfg || jsonb_build_object('move', format('update %s set %I = :NEW_START::%s%s where %I = :EVENT_ID::%s',
          meta.wizard_qname(p_table), v_a, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_a),
          case when v_b is not null then format(', %I = :NEW_END::%s', v_b, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_b)) else '' end,
          v_pk, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_pk)));
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'calendar', format(E'select %s\n  from %s t', v_src, meta.wizard_qname(p_table)), v_cfg)
      returning id into v_region;

    elsif p_kind = 'chart' then
      v_a := meta.wizard_col(p_table, o ->> 'label_column', 'label column');
      v_b := meta.wizard_col(p_table, o ->> 'value_column', 'value column');
      v_kind := coalesce(nullif(o ->> 'chart', ''), 'bar');
      v_c := lower(coalesce(nullif(o ->> 'function', ''), 'count'));
      if v_a is null then
        raise exception 'choose the label column of the chart';
      end if;
      if v_kind not in ('bar', 'column', 'line', 'area', 'donut', 'pie', 'funnel') then
        raise exception 'unknown chart type "%"', v_kind;
      end if;
      if v_c not in ('count', 'sum', 'avg', 'min', 'max') then
        raise exception 'unknown function "%"', v_c;
      end if;
      if v_c <> 'count' and (v_b is null or (select kind from meta.wizard_catalog(p_table) where column_name = v_b) <> 'number') then
        raise exception 'the function % needs a number column', v_c;
      end if;
      v_d := case when v_c = 'count' and v_b is null then 'Count'
                  else initcap(case v_c when 'avg' then 'average' when 'min' then 'minimum' when 'max' then 'maximum' else v_c end)
                       || ' of ' || meta.wizard_column_label(p_table, v_b) end;
      -- the label as a derived column, so a foreign key's display value can be grouped;
      -- (097) rows without a value are labelled "(none)" instead of an empty bar
      v_src := meta.wizard_expr(p_table, v_a);
      if exists (select 1 from meta.wizard_catalog(p_table) where column_name = v_a and (kind = 'text' or fk_table is not null) and not (not_null and fk_table is null)) then
        v_src := format('coalesce((%s)::text, %L)', v_src, '(none)');
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'chart',
              format(E'select t.%I,\n       %s as %I\n  from (select %s as %I%s from %s t) t\n group by 1\n order by %s',
                     meta.wizard_column_label(p_table, v_a),
                     case when v_b is null then 'count(*)' else format('%s(t.%I)', v_c, v_b) end, v_d,
                     v_src, meta.wizard_column_label(p_table, v_a),
                     case when v_b is null then '' else format(', t.%I', v_b) end,
                     meta.wizard_qname(p_table), case when v_kind in ('bar', 'donut', 'pie', 'funnel') then '2 desc' else '1' end),
              jsonb_build_object('kind', v_kind) || case when v_kind in ('bar', 'donut', 'pie', 'funnel') then '{"top": 10}'::jsonb else '{}' end)
      returning id into v_region;

    elsif p_kind = 'map' then
      v_a := meta.wizard_col(p_table, o ->> 'lat', 'latitude column');
      v_b := meta.wizard_col(p_table, o ->> 'lng', 'longitude column');
      v_c := meta.wizard_col(p_table, o ->> 'location', 'location column');
      if v_c is not null then
        v_kind := (select kind from meta.wizard_catalog(p_table) where column_name = v_c);
        v_src := case v_kind
          when 'geometry' then format('st_y(st_pointonsurface(t.%1$I::geometry)) as lat, st_x(st_pointonsurface(t.%1$I::geometry)) as lng', v_c)
          when 'point' then format('t.%1$I[1] as lat, t.%1$I[0] as lng', v_c)
          when 'text' then format('t.%I as location', v_c)
          else null end;
        -- lines and areas are drawn as shapes too
        if v_kind = 'geometry' then
          v_geo := format('case when geometrytype(t.%1$I::geometry) <> ''POINT'' then st_asgeojson(t.%1$I::geometry) end as geojson', v_c);
        end if;
        if v_src is null then
          raise exception 'the location column must hold "latitude,longitude" text, a point or a PostGIS geometry';
        end if;
        v_d := format('t.%I is not null', v_c);
      elsif v_a is not null and v_b is not null then
        if (select count(*) from meta.wizard_catalog(p_table) where column_name in (v_a, v_b) and kind = 'number') <> 2 then
          raise exception 'latitude and longitude must be number columns';
        end if;
        v_src := format('t.%I as lat, t.%I as lng', v_a, v_b);
        v_d := format('t.%I is not null and t.%I is not null', v_a, v_b);
      else
        raise exception 'a map needs latitude and longitude columns, or a location, point or geometry column';
      end if;
      v_cols := concat_ws(E',\n       ', v_src, v_geo,
        meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'title', 'title column')) || ' as title',
        meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'body', 'body column')) || ' as body',
        v_key);
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'map', format(E'select %s\n  from %s t\n where %s', v_cols, meta.wizard_qname(p_table), v_d),
              jsonb_strip_nulls(jsonb_build_object('link', v_link)))
      returning id into v_region;
      if coalesce((o ->> 'report')::boolean, true) then
        -- a report of the same rows, filtered by the map area ("Show this area in the list")
        insert into meta.region (page_id, seq, title, type, source, config)
        values (v_page, 20, v_label || ' list', 'report',
                format(E'select %s,\n       %s\n  from %s t',
                       (select string_agg(meta.wizard_expr(p_table, column_name) || ' as ' || quote_ident(column_name), ', ' order by ordinal)
                          from meta.wizard_catalog(p_table)
                         where kind not in ('binary', 'geometry', 'point') and column_name not in ('lat', 'lng', 'location')
                           and not (column_name = any (v_skip))),
                       v_src, meta.wizard_qname(p_table)),
                jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk),
                  'headings', (select jsonb_object_agg(column_name, meta.wizard_column_label(p_table, column_name)) from meta.wizard_catalog(p_table)))))
        returning id into v_report;
        update meta.region set config = config || jsonb_build_object('report', v_report) where id = v_region;
      end if;

    elsif p_kind = 'facets' then
      perform meta.wizard_col(p_table, x, 'report column') from jsonb_array_elements_text(coalesce(o -> 'columns', '[]')) x;
      perform meta.wizard_col(p_table, x, 'facet column') from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) x;
      -- the report: the chosen columns, and the parent's display column next to each foreign key
      v_cols := null;
      for c in
        select w.* from meta.wizard_catalog(p_table) w
         where w.column_name in (select x from jsonb_array_elements_text(coalesce(o -> 'columns', '[]')) x)
            or w.is_pk
            or w.column_name in (select x from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) x)
         order by w.ordinal
      loop
        continue when c.kind in ('binary', 'geometry');
        v_cols := concat_ws(E',\n       ', v_cols, format('t.%I', c.column_name));
        v_heads := v_heads || jsonb_build_object(c.column_name, meta.wizard_column_label(p_table, c.column_name));
        if c.fk_display is not null and c.fk_display <> c.fk_column then
          v_cols := concat_ws(E',\n       ', v_cols, meta.wizard_expr(p_table, c.column_name) || ' as ' || quote_ident(c.column_name || '_' || c.fk_display));
          v_heads := v_heads || jsonb_build_object(c.column_name || '_' || c.fk_display, meta.wizard_column_label(p_table, c.column_name));
        end if;
      end loop;
      if v_cols is null then
        raise exception 'choose at least one report column';
      end if;
      for c in
        select w.* from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) with ordinality x(col, n)
          join meta.wizard_catalog(p_table) w on w.column_name = x.col
         order by x.n
      loop
        continue when c.kind in ('binary', 'geometry', 'point', 'other');
        v_facets := v_facets || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'column', case when c.fk_display is not null and c.fk_display <> c.fk_column then c.column_name || '_' || c.fk_display else c.column_name end,
          'label', meta.wizard_column_label(p_table, c.column_name),
          'type', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then 'range' end,
          'custom', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then true end)));
      end loop;
      insert into meta.region (page_id, seq, title, type, columns, source, config)
      values (v_page, 20, v_label, 'report', 9, format(E'select %s\n  from %s t', v_cols, meta.wizard_qname(p_table)),
              jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk), 'headings', v_heads)))
      returning id into v_region;
      insert into meta.region (page_id, seq, title, type, columns, template, config)
      values (v_page, 10, 'Filters', 'facets', 3, 'collapsible',
              jsonb_build_object('report', v_region, 'search', coalesce((o ->> 'search')::boolean, true), 'facets', v_facets));
    end if;

    if v_fpage is not null then
      perform meta.wizard_form(v_app, p_table, v_fpage, v_flabel, p_page, true, null);
      insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
      values (v_page, v_region, 10, 'CREATE', 'Create', 'redirect', v_fpage, true);
    end if;
  end if;

  if coalesce((o ->> 'nav')::boolean, false) then
    perform meta.wizard_nav(v_app, v_label, v_icon, p_page);
  end if;
  return v_page;
end
$$;

revoke all on function meta.wizard_abbreviations(), meta.wizard_is_word(text), meta.wizard_word(text), meta.wizard_uncountable(text),
  meta.wizard_plural(text), meta.wizard_singular(text), meta.wizard_short(text, int), meta.wizard_table_label(regclass, boolean),
  meta.wizard_column_label(regclass, text), meta.wizard_files(regclass), meta.wizard_sidecars(regclass),
  meta.wizard_mask(text, text, boolean), meta.wizard_report(regclass, text[]),
  meta.wizard_report_form(meta.app, regclass, int, int, text, text)
  from public;
