-- =====================================================================
-- 070: more of the APEX PL/SQL APIs in SQL
--
-- - meta.parse_data reads XML (as the data loader does: the rows of a
--   repeating element, attributes as "@name", nested elements by path) and
--   Excel (.xlsx) files.
-- - APEX_ZIP: meta.zip_add / meta.zip_finish (and the aggregate
--   meta.zip_agg) build a zip in SQL; meta.zip_entries / meta.zip_entry read
--   one.
-- - BOOLEAN session state: meta.v_boolean(item).
--
-- PostgreSQL can't decompress (inflate) in SQL. Zip archives and .xlsx
-- files are therefore unpacked by the pgkiln server when it receives them
-- (a file item's upload, a meta.web_request() response) into
-- meta.unpacked_file, keyed by the SHA-256 of the file and kept for 24
-- hours; the SQL functions find their entries and sheets by the content they
-- are given. Zips built in SQL store their entries uncompressed, so SQL reads
-- them without the server.
-- =====================================================================

create table meta.unpacked_file (
  digest     bytea primary key check (octet_length(digest) = 32),
  kind       text not null check (kind in ('zip', 'xlsx')),
  -- xlsx: [{"name": "Sheet1", "rows": [["a", "b"], ["1", null]]}], cells as text like the data loader
  sheets     jsonb,
  created_at timestamptz not null default now()
);
create table meta.unpacked_entry (
  digest  bytea not null references meta.unpacked_file on delete cascade,
  seq     int not null,
  name    text not null,
  content bytea not null,
  primary key (digest, name)
);
create index on meta.unpacked_file (created_at);
revoke all on meta.unpacked_file, meta.unpacked_entry from public;
comment on table meta.unpacked_file is 'Zip and .xlsx files the server unpacked (070), by SHA-256 of the content, for 24 hours';

-- ---------------------------------------------------------------- little-endian helpers

create function meta.le_bytes(p_value bigint, p_bytes int) returns bytea
language sql immutable strict parallel safe set search_path = pg_catalog as $$
  select decode(string_agg(lpad(to_hex((p_value >> (8 * i)) & 255), 2, '0'), '' order by i), 'hex')
    from generate_series(0, p_bytes - 1) i
$$;

create function meta.le_read(p_data bytea, p_offset int, p_bytes int) returns bigint
language sql immutable strict parallel safe set search_path = pg_catalog as $$
  select coalesce(sum(get_byte(p_data, p_offset + i)::bigint << (8 * i)), 0)::bigint from generate_series(0, p_bytes - 1) i
$$;

-- ---------------------------------------------------------------- CRC-32 (zip)

create function meta.crc32(p_data bytea) returns bigint
language plpgsql immutable strict parallel safe set search_path = pg_catalog as $$
declare
  t constant bigint[] := array[
    0, 1996959894, 3993919788, 2567524794, 124634137, 1886057615, 3915621685, 2657392035,
    249268274, 2044508324, 3772115230, 2547177864, 162941995, 2125561021, 3887607047, 2428444049,
    498536548, 1789927666, 4089016648, 2227061214, 450548861, 1843258603, 4107580753, 2211677639,
    325883990, 1684777152, 4251122042, 2321926636, 335633487, 1661365465, 4195302755, 2366115317,
    997073096, 1281953886, 3579855332, 2724688242, 1006888145, 1258607687, 3524101629, 2768942443,
    901097722, 1119000684, 3686517206, 2898065728, 853044451, 1172266101, 3705015759, 2882616665,
    651767980, 1373503546, 3369554304, 3218104598, 565507253, 1454621731, 3485111705, 3099436303,
    671266974, 1594198024, 3322730930, 2970347812, 795835527, 1483230225, 3244367275, 3060149565,
    1994146192, 31158534, 2563907772, 4023717930, 1907459465, 112637215, 2680153253, 3904427059,
    2013776290, 251722036, 2517215374, 3775830040, 2137656763, 141376813, 2439277719, 3865271297,
    1802195444, 476864866, 2238001368, 4066508878, 1812370925, 453092731, 2181625025, 4111451223,
    1706088902, 314042704, 2344532202, 4240017532, 1658658271, 366619977, 2362670323, 4224994405,
    1303535960, 984961486, 2747007092, 3569037538, 1256170817, 1037604311, 2765210733, 3554079995,
    1131014506, 879679996, 2909243462, 3663771856, 1141124467, 855842277, 2852801631, 3708648649,
    1342533948, 654459306, 3188396048, 3373015174, 1466479909, 544179635, 3110523913, 3462522015,
    1591671054, 702138776, 2966460450, 3352799412, 1504918807, 783551873, 3082640443, 3233442989,
    3988292384, 2596254646, 62317068, 1957810842, 3939845945, 2647816111, 81470997, 1943803523,
    3814918930, 2489596804, 225274430, 2053790376, 3826175755, 2466906013, 167816743, 2097651377,
    4027552580, 2265490386, 503444072, 1762050814, 4150417245, 2154129355, 426522225, 1852507879,
    4275313526, 2312317920, 282753626, 1742555852, 4189708143, 2394877945, 397917763, 1622183637,
    3604390888, 2714866558, 953729732, 1340076626, 3518719985, 2797360999, 1068828381, 1219638859,
    3624741850, 2936675148, 906185462, 1090812512, 3747672003, 2825379669, 829329135, 1181335161,
    3412177804, 3160834842, 628085408, 1382605366, 3423369109, 3138078467, 570562233, 1426400815,
    3317316542, 2998733608, 733239954, 1555261956, 3268935591, 3050360625, 752459403, 1541320221,
    2607071920, 3965973030, 1969922972, 40735498, 2617837225, 3943577151, 1913087877, 83908371,
    2512341634, 3803740692, 2075208622, 213261112, 2463272603, 3855990285, 2094854071, 198958881,
    2262029012, 4057260610, 1759359992, 534414190, 2176718541, 4139329115, 1873836001, 414664567,
    2282248934, 4279200368, 1711684554, 285281116, 2405801727, 4167216745, 1634467795, 376229701,
    2685067896, 3608007406, 1308918612, 956543938, 2808555105, 3495958263, 1231636301, 1047427035,
    2932959818, 3654703836, 1088359270, 936918000, 2847714899, 3736837829, 1202900863, 817233897,
    3183342108, 3401237130, 1404277552, 615818150, 3134207493, 3453421203, 1423857449, 601450431,
    3009837614, 3294710456, 1567103746, 711928724, 3020668471, 3272380065, 1510334235, 755167117
  ];
  c bigint := 4294967295;
  i int;
begin
  for i in 0 .. length(p_data) - 1 loop
    c := t[((c # get_byte(p_data, i)) & 255) + 1] # (c >> 8);
  end loop;
  return c # 4294967295;
end
$$;

-- PostgreSQL 18 has crc32() built in: much faster
do $$
begin
  if to_regprocedure('pg_catalog.crc32(bytea)') is not null then
    execute $f$create or replace function meta.crc32(p_data bytea) returns bigint
      language sql immutable strict parallel safe set search_path = pg_catalog as 'select pg_catalog.crc32(p_data)'$f$;
  end if;
end
$$;

-- ---------------------------------------------------------------- APEX_ZIP

-- Add a file to a zip being built (APEX: apex_zip.add_file). The entry is
-- stored uncompressed; meta.zip_finish adds the directory.
create function meta.zip_add(p_zip bytea, p_name text, p_content bytea) returns bytea
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  v_name bytea;
  v_now  timestamp := localtimestamp;
  v_time int := (extract(hour from v_now)::int << 11) | (extract(minute from v_now)::int << 5) | (extract(second from v_now)::int / 2);
  v_date int := ((greatest(extract(year from v_now)::int, 1980) - 1980) << 9) | (extract(month from v_now)::int << 5) | extract(day from v_now)::int;
  v_data bytea := coalesce(p_content, ''::bytea);
begin
  if p_name is null or btrim(p_name) = '' or p_name ~ '(^/|\\|(^|/)\.\.(/|$))' or length(p_name) > 255 then
    raise exception 'meta.zip_add: the name is a relative path of at most 255 characters (no "..", no leading /)';
  end if;
  if p_zip is not null and position('\x504b0506'::bytea in p_zip) > 0 and meta.le_read(p_zip, length(p_zip) - 22, 4) = 101010256 then
    raise exception 'meta.zip_add: the zip is finished already (add files before meta.zip_finish)';
  end if;
  if length(v_data) > 1000000000 then
    raise exception 'meta.zip_add: a file may hold at most 1 GB';
  end if;
  v_name := convert_to(p_name, 'UTF8');
  return coalesce(p_zip, ''::bytea)
    || '\x504b0304'::bytea || meta.le_bytes(20, 2) || meta.le_bytes(2048, 2) -- version 2.0; flag: UTF-8 names
    || meta.le_bytes(0, 2)                                                   -- method: stored
    || meta.le_bytes(v_time, 2) || meta.le_bytes(v_date, 2)
    || meta.le_bytes(meta.crc32(v_data), 4) || meta.le_bytes(length(v_data), 4) || meta.le_bytes(length(v_data), 4)
    || meta.le_bytes(length(v_name), 2) || meta.le_bytes(0, 2)
    || v_name || v_data;
end
$$;

-- Finish a zip built with meta.zip_add (APEX: apex_zip.finish): the central directory.
create function meta.zip_finish(p_zip bytea) returns bytea
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  v_zip bytea := coalesce(p_zip, ''::bytea);
  v_cd  bytea := ''::bytea;
  v_off int := 0;
  v_n   int := 0;
  v_len int;
  v_ext int;
  v_size bigint;
begin
  while v_off < length(v_zip) loop
    if meta.le_read(v_zip, v_off, 4) <> 67324752 then
      raise exception 'meta.zip_finish: not a zip built with meta.zip_add (or finished already)';
    end if;
    v_size := meta.le_read(v_zip, v_off + 18, 4);
    v_len := meta.le_read(v_zip, v_off + 26, 2);
    v_ext := meta.le_read(v_zip, v_off + 28, 2);
    v_cd := v_cd || '\x504b0102'::bytea || meta.le_bytes(20, 2)
      || substring(v_zip from v_off + 5 for 26)   -- version needed … extra length, as in the local header
      || meta.le_bytes(0, 2) || meta.le_bytes(0, 2) || meta.le_bytes(0, 2) || meta.le_bytes(0, 4)
      || meta.le_bytes(v_off, 4)
      || substring(v_zip from v_off + 31 for v_len);
    v_n := v_n + 1;
    v_off := v_off + 30 + v_len + v_ext + v_size::int;
  end loop;
  if v_n > 65535 then
    raise exception 'meta.zip_finish: at most 65535 files';
  end if;
  return v_zip || v_cd || '\x504b0506'::bytea || meta.le_bytes(0, 2) || meta.le_bytes(0, 2)
    || meta.le_bytes(v_n, 2) || meta.le_bytes(v_n, 2) || meta.le_bytes(length(v_cd), 4) || meta.le_bytes(length(v_zip), 4) || meta.le_bytes(0, 2);
end
$$;

-- select meta.zip_agg(file_name, content order by file_name) from …: one zip of the rows' files
create function meta.zip_agg_step(p_zip bytea, p_name text, p_content bytea) returns bytea
language sql immutable set search_path = meta, pg_catalog as $$ select meta.zip_add(p_zip, p_name, p_content) $$;
create aggregate meta.zip_agg(text, bytea) (sfunc = meta.zip_agg_step, stype = bytea, finalfunc = meta.zip_finish);

-- The files in a zip (APEX: apex_zip.get_files): a zip the server unpacked
-- when it received it, or one whose entries are stored uncompressed.
create function meta.zip_entries(p_zip bytea) returns table (name text, size bigint)
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_digest bytea;
  v_eocd int;
  v_cd int;
  v_n int;
  v_len int;
  i int;
begin
  if p_zip is null then
    return;
  end if;
  v_digest := sha256(p_zip);
  if exists (select 1 from meta.unpacked_file f where f.digest = v_digest) then
    return query select e.name, octet_length(e.content)::bigint from meta.unpacked_entry e where e.digest = v_digest and e.name !~ '/$' order by e.seq;
    return;
  end if;
  -- the end of central directory record: within the last 64 KB
  v_eocd := length(p_zip) - 22;
  while v_eocd >= greatest(0, length(p_zip) - 22 - 65535) and meta.le_read(p_zip, v_eocd, 4) <> 101010256 loop
    v_eocd := v_eocd - 1;
  end loop;
  if v_eocd < 0 or length(p_zip) < 22 or meta.le_read(p_zip, v_eocd, 4) <> 101010256 then
    raise exception 'meta.zip_entries: this is not a zip file';
  end if;
  v_n := meta.le_read(p_zip, v_eocd + 10, 2);
  v_cd := meta.le_read(p_zip, v_eocd + 16, 4);
  for i in 1 .. v_n loop
    if meta.le_read(p_zip, v_cd, 4) <> 33639248 then
      raise exception 'meta.zip_entries: the zip''s directory is damaged';
    end if;
    v_len := meta.le_read(p_zip, v_cd + 28, 2);
    name := convert_from(substring(p_zip from v_cd + 47 for v_len), 'UTF8');
    size := meta.le_read(p_zip, v_cd + 24, 4);
    if name !~ '/$' then
      return next;
    end if;
    v_cd := v_cd + 46 + v_len + meta.le_read(p_zip, v_cd + 30, 2)::int + meta.le_read(p_zip, v_cd + 32, 2)::int;
  end loop;
end
$$;

-- One file of a zip (APEX: apex_zip.get_file_content), or null when there is no such file.
create function meta.zip_entry(p_zip bytea, p_name text) returns bytea
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_digest bytea;
  v_eocd int;
  v_cd int;
  v_n int;
  v_len int;
  v_name text;
  v_method int;
  v_local int;
  i int;
begin
  if p_zip is null or p_name is null then
    return null;
  end if;
  v_digest := sha256(p_zip);
  if exists (select 1 from meta.unpacked_file f where f.digest = v_digest) then
    return (select e.content from meta.unpacked_entry e where e.digest = v_digest and e.name = p_name);
  end if;
  v_eocd := length(p_zip) - 22;
  while v_eocd >= greatest(0, length(p_zip) - 22 - 65535) and meta.le_read(p_zip, v_eocd, 4) <> 101010256 loop
    v_eocd := v_eocd - 1;
  end loop;
  if v_eocd < 0 or length(p_zip) < 22 or meta.le_read(p_zip, v_eocd, 4) <> 101010256 then
    raise exception 'meta.zip_entry: this is not a zip file';
  end if;
  v_n := meta.le_read(p_zip, v_eocd + 10, 2);
  v_cd := meta.le_read(p_zip, v_eocd + 16, 4);
  for i in 1 .. v_n loop
    v_len := meta.le_read(p_zip, v_cd + 28, 2);
    v_name := convert_from(substring(p_zip from v_cd + 47 for v_len), 'UTF8');
    if v_name = p_name then
      v_method := meta.le_read(p_zip, v_cd + 10, 2);
      if v_method <> 0 then
        raise exception using errcode = 'feature_not_supported',
          message = format('meta.zip_entry: %s is compressed, and PostgreSQL can''t decompress', p_name),
          hint = 'pgkiln unpacks zips it receives (a file item''s upload, a meta.web_request() response) for 24 hours; read the file from those.';
      end if;
      v_local := meta.le_read(p_zip, v_cd + 42, 4);
      return substring(p_zip from v_local + 31 + meta.le_read(p_zip, v_local + 26, 2)::int + meta.le_read(p_zip, v_local + 28, 2)::int
                       for meta.le_read(p_zip, v_cd + 20, 4)::int);
    end if;
    v_cd := v_cd + 46 + v_len + meta.le_read(p_zip, v_cd + 30, 2)::int + meta.le_read(p_zip, v_cd + 32, 2)::int;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------- XML rows (as the data loader)

-- Walk the elements inside a row in document order: attributes when an
-- element opens ("path/@name"), a leaf element's text when it closes
-- ("path"); an element is a leaf while no column starts with its path
-- (src/xml.ts xmlTable, the data loader's rules).
create function meta.xml_walk(p_node xml, p_rel text, inout p_headers text[], inout p_row jsonb)
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  c record;
  a record;
  v_rel text;
  v_key text;
  v_t text;
begin
  for c in select * from xmltable('/*/*' passing p_node columns name text path 'local-name(.)', node xml path '.', txt text path 'string(.)') loop
    v_rel := case when p_rel = '' then c.name else p_rel || '/' || c.name end;
    for a in select * from xmltable('/*/@*' passing c.node columns name text path 'local-name(.)', val text path '.') loop
      v_key := v_rel || '/@' || a.name;
      if not v_key = any (p_headers) then p_headers := p_headers || v_key; end if;
      if not p_row ? v_key then p_row := p_row || jsonb_build_object(v_key, a.val); end if;
    end loop;
    select w.p_headers, w.p_row into p_headers, p_row from meta.xml_walk(c.node, v_rel, p_headers, p_row) w;
    if not exists (select 1 from unnest(p_headers) h where left(h, length(v_rel) + 1) = v_rel || '/') then
      if not v_rel = any (p_headers) then p_headers := p_headers || v_rel; end if;
      v_t := btrim(c.txt, E' \t\r\n');
      if v_t <> '' and not p_row ? v_rel then p_row := p_row || jsonb_build_object(v_rel, v_t); end if;
    end if;
  end loop;
end
$$;

-- The row element when none is given: the element path that occurs most
-- often among elements with children or attributes (not the root).
create function meta.xml_row_path(p_doc xml) returns text
language sql immutable set search_path = meta, pg_catalog as $$
  with recursive t(node, path, depth, rich, ord) as (
    select x.node, x.name, 1, x.kids + x.attrs > 0, array[x.o::int]
      from xmltable('/*' passing p_doc columns o for ordinality, node xml path '.', name text path 'local-name(.)', kids int path 'count(*)', attrs int path 'count(@*)') x
    union all
    select c.node, t.path || '/' || c.name, t.depth + 1, c.kids + c.attrs > 0, t.ord || c.o::int
      from t, xmltable('/*/*' passing t.node columns o for ordinality, node xml path '.', name text path 'local-name(.)', kids int path 'count(*)', attrs int path 'count(@*)') c
  ), counts as (
    -- ties go to the path that comes first in the document (as the data loader)
    select path, count(*) as n, bool_or(rich) as rich, min(depth) as depth, min(ord) as first from t group by path
  )
  select coalesce(
    (select regexp_replace(path, '^[^/]+/', '') from counts where depth > 1 order by rich desc, n desc, depth, first limit 1),
    (select path from counts order by depth limit 1))
$$;

-- The rows of an XML document: line 0 the column names, then one row per
-- repeating element.
create function meta.xml_rows(p_text text, p_row text, p_max int) returns table (line_number int, cols text[])
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  v_doc     xml;
  v_path    text := btrim(coalesce(p_row, ''), E'/ \t');
  v_want    text[];
  v_expr    text;
  v_headers text[] := '{}';
  v_rows    jsonb[] := '{}';
  v_row     jsonb;
  v_t       text;
  n         record;
  a         record;
begin
  -- like the data loader: no DTDs or entities (no entity expansion, no external files)
  if p_text ~* '<!(DOCTYPE|ENTITY)' then
    raise exception 'meta.parse_data: XML with a DTD or entity declarations is refused';
  end if;
  begin
    v_doc := xmlparse(document p_text);
  exception when others then
    raise exception 'meta.parse_data: this is not valid XML (%)', sqlerrm;
  end;
  if v_path = '' then
    v_path := meta.xml_row_path(v_doc);
  end if;
  if v_path !~ '^[A-Za-z_][A-Za-z0-9_.:-]*(/[A-Za-z_][A-Za-z0-9_.:-]*)*$' then
    raise exception 'meta.parse_data: % is not an element name or path', p_row;
  end if;
  v_want := array(select regexp_replace(w, '^.*:', '') from unnest(string_to_array(v_path, '/')) w);
  -- elements whose path ends in the wanted names, not inside another row
  v_expr := '//' || array_to_string(array(select format('*[local-name()="%s"]', w) from unnest(v_want) w), '/')
         || format('[not(ancestor::*[local-name()="%s"])]', v_want[cardinality(v_want)]);
  for n in select * from xmltable(v_expr passing v_doc columns name text path 'local-name(.)', node xml path '.', txt text path 'string(.)') loop
    v_row := '{}';
    for a in select * from xmltable('/*/@*' passing n.node columns name text path 'local-name(.)', val text path '.') loop
      if not ('@' || a.name) = any (v_headers) then v_headers := v_headers || ('@' || a.name); end if;
      if not v_row ? ('@' || a.name) then v_row := v_row || jsonb_build_object('@' || a.name, a.val); end if;
    end loop;
    select w.p_headers, w.p_row into v_headers, v_row from meta.xml_walk(n.node, '', v_headers, v_row) w;
    -- a row element with text only: one column named after it
    v_t := btrim(n.txt, E' \t\r\n');
    if v_row = '{}' and v_t <> '' then
      if not n.name = any (v_headers) then v_headers := v_headers || n.name; end if;
      v_row := jsonb_build_object(n.name, v_t);
    end if;
    if cardinality(v_rows) >= p_max then
      raise exception 'meta.parse_data: the file has more than % rows; at most % can be parsed at once', p_max, p_max;
    end if;
    v_rows := v_rows || v_row;
  end loop;
  if cardinality(v_rows) = 0 then
    raise exception 'meta.parse_data: no <%> elements were found', v_want[cardinality(v_want)];
  end if;
  line_number := 0;
  cols := v_headers;
  return next;
  return query
    select r.o::int, array(select nullif(btrim(r.v ->> h.k, E' \t\r\n'), '') from unnest(v_headers) with ordinality h(k, i) order by h.i)
      from unnest(v_rows) with ordinality r(v, o) order by r.o;
end
$$;

-- ---------------------------------------------------------------- Excel rows

-- The rows of an .xlsx file's sheet (the first, or the one named in
-- p_sheet), as the server read them (meta.unpacked_file), numbered like CSV.
create function meta.xlsx_rows(p_content bytea, p_sheet text, p_headers boolean, p_skip int, p_max int)
returns table (line_number int, cols text[])
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_sheets jsonb;
  v_sheet  jsonb;
  v_count  int;
begin
  select f.sheets into v_sheets from meta.unpacked_file f where f.digest = sha256(p_content) and f.kind = 'xlsx';
  if v_sheets is null then
    raise exception using errcode = 'feature_not_supported',
      message = 'meta.parse_data: this Excel (.xlsx) file has not been read by pgkiln (PostgreSQL can''t decompress it).',
      hint = 'pgkiln reads .xlsx files it receives (a file item''s upload, a meta.web_request() response) for 24 hours; parse those, or load the file with a data_load process.';
  end if;
  select s into v_sheet from jsonb_array_elements(v_sheets) with ordinality x(s, o)
   where nullif(p_sheet, '') is null or s ->> 'name' = p_sheet order by o limit 1;
  if v_sheet is null then
    raise exception 'meta.parse_data: the file has no sheet named % (it has %)', p_sheet,
      (select string_agg(s ->> 'name', ', ') from jsonb_array_elements(v_sheets) s);
  end if;
  return query
    with r as (
      select x.o, array(select nullif(btrim(c), '') from jsonb_array_elements_text(x.v) with ordinality y(c, i) order by y.i) as c
        from jsonb_array_elements(v_sheet -> 'rows') with ordinality x(v, o)
    ), kept as (
      select c, row_number() over (order by o) as n from r where exists (select 1 from unnest(c) z where z is not null)
    )
    select (k.n - p_skip - case when p_headers then 1 else 0 end)::int, k.c from kept k where k.n > p_skip order by k.n;
  get diagnostics v_count = row_count;
  if v_count - (case when p_headers then 1 else 0 end) > p_max then
    raise exception 'meta.parse_data: the file has % rows; at most % can be parsed at once', v_count - 1, p_max;
  end if;
end
$$;

-- ---------------------------------------------------------------- parse_data, redefined (052 + XML and Excel)

create or replace function meta.parse_data_rows(
  p_content      bytea,
  p_file_name    text    default null,
  p_format       text    default 'auto',
  p_headers      boolean default true,
  p_delimiter    text    default null,
  p_row_selector text    default null,
  p_skip_rows    int     default 0,
  p_max_rows     int     default 100000
) returns table (line_number int, cols text[])
language plpgsql stable set search_path = meta, pg_catalog as $$
declare
  v_format text := lower(coalesce(nullif(p_format, ''), 'auto'));
  v_text   text;
  v_head   text;
  v_d      text;
  v_re     text;
  v_json   json;
  v_keys   text[];
  v_count  int;
  v_skip   int := greatest(coalesce(p_skip_rows, 0), 0);
  v_max    int := least(greatest(coalesce(p_max_rows, 100000), 1), 1000000);
  v_part   text;
  v_arrays json[];
begin
  if v_format not in ('auto', 'csv', 'tsv', 'json', 'xlsx', 'xml') then
    raise exception 'meta.parse_data: the format is auto, csv, tsv, json, xml or xlsx';
  end if;
  if p_content is null then
    return;
  end if;
  -- Excel files are zip archives of deflate-compressed parts: no inflate in SQL
  if v_format = 'xlsx' or (v_format = 'auto' and (p_file_name ~* '\.(xlsx|xlsm|xls|ods)$'
      or substring(p_content from 1 for 4) = '\x504b0304'::bytea)) then
    -- (070) the sheets the server read when the file arrived (an upload or a web response)
    return query select * from meta.xlsx_rows(p_content, p_row_selector, p_headers, v_skip, v_max);
    return;
  end if;
  if position('\x00'::bytea in p_content) > 0 then
    raise exception 'meta.parse_data: this is not a text (CSV, JSON or XML) file';
  end if;
  -- UTF-8 (with or without BOM); not valid UTF-8: Windows-1252, else Latin-1
  begin
    v_text := convert_from(p_content, 'UTF8');
  exception when others then
    begin
      v_text := convert_from(p_content, 'WIN1252');
    exception when others then
      v_text := convert_from(p_content, 'LATIN1');
    end;
  end;
  v_text := regexp_replace(v_text, '^﻿', '');
  v_head := left(v_text, 64);
  if v_format = 'xml' or (v_format = 'auto' and (p_file_name ~* '\.xml$' or v_head ~ '^\s*<[?!A-Za-z_]')) then
    -- (070) the rows of a repeating element, as the data loader reads them
    return query select * from meta.xml_rows(v_text, p_row_selector, v_max);
    return;
  end if;

  if v_format = 'json' or (v_format = 'auto' and (p_file_name ~* '\.(json|jsonl|ndjson)$' or v_head ~ '^\s*[\[{]')) then
    begin
      v_json := btrim(v_text, E' \t\r\n')::json;
    exception when others then
      -- JSON Lines: one value per line
      begin
        select json_agg(l::json order by o) into v_json
          from regexp_split_to_table(btrim(v_text, E' \t\r\n'), '\r?\n') with ordinality s(l, o) where btrim(l, E' \t\r') <> '';
      exception when others then
        raise exception 'meta.parse_data: this is not valid JSON (%)', sqlerrm;
      end;
    end;
    if nullif(p_row_selector, '') is not null then
      -- a path to the array of records: "data" or "result.items"
      foreach v_part in array string_to_array(p_row_selector, '.') loop
        v_json := case when v_part ~ '^[0-9]+$' and json_typeof(v_json) = 'array' then v_json -> v_part::int else v_json -> v_part end;
      end loop;
      if v_json is null then
        raise exception 'meta.parse_data: the row selector % finds nothing', p_row_selector;
      end if;
    end if;
    if json_typeof(v_json) = 'object' then
      -- an object with one array of records ({"employees": [...]}), else one record
      select array_agg(value) into v_arrays from json_each(v_json) where json_typeof(value) = 'array';
      v_json := case when cardinality(v_arrays) = 1 then v_arrays[1] else json_build_array(v_json) end;
    end if;
    if json_typeof(v_json) is distinct from 'array' or json_array_length(v_json) = 0 then
      raise exception 'meta.parse_data: the JSON holds no records (expected an array of objects)';
    end if;
    v_count := json_array_length(v_json);
    if v_count > v_max then
      raise exception 'meta.parse_data: the file has % rows; at most % can be parsed at once', v_count, v_max;
    end if;
    if exists (select 1 from json_array_elements(v_json) e where json_typeof(e) <> 'object') then
      raise exception 'meta.parse_data: every JSON record must be an object ({"column": value, …})';
    end if;
    -- the keys in the order they first appear
    select array_agg(key order by ro, ko) into v_keys
      from (select k.key, r.o as ro, k.o as ko, row_number() over (partition by k.key order by r.o, k.o) as rn
              from json_array_elements(v_json) with ordinality r(v, o), json_each(r.v) with ordinality k(key, value, o)) x
     where rn = 1;
    line_number := 0;
    cols := coalesce(v_keys, '{}');
    return next;
    return query
      select r.o::int, array(select nullif(r.v ->> h.k, '') from unnest(coalesce(v_keys, '{}')) with ordinality h(k, i) order by h.i)
        from json_array_elements(v_json) with ordinality r(v, o)
       order by r.o;
    return;
  end if;

  -- CSV / TSV: RFC 4180 (quoted fields with "" escapes and line breaks, CRLF or LF)
  v_d := coalesce(p_delimiter, case when v_format = 'tsv' or p_file_name ~* '\.tsv$' then E'\t' end);
  if v_d is null then
    -- the delimiter that splits the first line into the most fields (outside quotes)
    declare
      q boolean := false;
      n_comma int := 0; n_semi int := 0; n_tab int := 0; n_bar int := 0;
      ch text;
    begin
      foreach ch in array regexp_split_to_array(left(v_text, 10000), '') loop
        if ch = '"' then q := not q;
        elsif not q and ch in (E'\n', E'\r') then exit;
        elsif not q and ch = ',' then n_comma := n_comma + 1;
        elsif not q and ch = ';' then n_semi := n_semi + 1;
        elsif not q and ch = E'\t' then n_tab := n_tab + 1;
        elsif not q and ch = '|' then n_bar := n_bar + 1;
        end if;
      end loop;
      v_d := ',';
      if n_semi > n_comma then v_d := ';'; end if;
      if n_tab > greatest(n_comma, n_semi) then v_d := E'\t'; end if;
      if n_bar > greatest(n_comma, n_semi, n_tab) then v_d := '|'; end if;
    end;
  end if;
  if length(v_d) <> 1 or v_d in ('"', E'\r', E'\n') then
    raise exception 'meta.parse_data: the delimiter is one character (not a quote or a line break)';
  end if;
  v_re := case when v_d = E'\t' then '\t' when v_d ~ '[A-Za-z0-9]' then v_d else '\' || v_d end;
  v_re := '(?:"([^"]*(?:""[^"]*)*)"|([^' || v_re || '\r\n]*))(' || v_re || '|\r\n|\n|\r|$)';
  return query
    with m as (
      select x.m, x.o from regexp_matches(v_text, v_re, 'g') with ordinality x(m, o)
    ), f as (
      select o, case when m[1] is not null then replace(m[1], '""', '"') else m[2] end as v,
             coalesce(sum(case when m[3] = v_d then 0 else 1 end)
                        over (order by o rows between unbounded preceding and 1 preceding), 0) as r
        from m
    ), rows_ as (
      select r, array_agg(case when v ~ '^\s*$' then null else v end order by o) as c from f group by r
    ), kept as (
      -- completely empty lines are skipped
      select r, c, row_number() over (order by r) as n from rows_ where exists (select 1 from unnest(c) x where x is not null)
    )
    select (k.n - v_skip - case when p_headers then 1 else 0 end)::int, k.c
      from kept k where k.n > v_skip order by k.r;
  get diagnostics v_count = row_count;
  v_count := v_count - (case when p_headers then 1 else 0 end);
  if v_count > v_max then
    raise exception 'meta.parse_data: the file has % rows; at most % can be parsed at once', v_count, v_max;
  end if;
end
$$;

-- ---------------------------------------------------------------- BOOLEAN session state

-- An item's value as a boolean (APEX 26.1: BOOLEAN session state; apex_util
-- .get_session_state_boolean): true, t, yes, y, 1, on → true; false, f, no,
-- n, 0, off → false; empty or anything else → null. Switches and checkboxes
-- store true / false.
create function meta.v_boolean(p_name text) returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select case
    when lower(btrim(v)) in ('true', 't', 'yes', 'y', '1', 'on') then true
    when lower(btrim(v)) in ('false', 'f', 'no', 'n', '0', 'off') then false
  end
  from (select meta.v(p_name) as v) x
$$;

grant execute on function meta.le_bytes(bigint, int), meta.le_read(bytea, int, int), meta.crc32(bytea),
  meta.zip_add(bytea, text, bytea), meta.zip_finish(bytea), meta.zip_agg_step(bytea, text, bytea),
  meta.zip_entries(bytea), meta.zip_entry(bytea, text),
  meta.xml_walk(xml, text, text[], jsonb), meta.xml_row_path(xml), meta.xml_rows(text, text, int),
  meta.xlsx_rows(bytea, text, boolean, int, int), meta.v_boolean(text) to public;
grant execute on function meta.zip_agg(text, bytea) to public;
