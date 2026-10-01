// pgapex builder: code editor for <textarea data-code="sql|plpgsql|json|html|text">.
//
// Progressive enhancement, no dependencies. The native textarea stays the
// source of truth (form posts, undo, spell checking off, screen readers): its
// text is drawn transparent on top of a highlighted copy, which follows its
// scroll position. Only the visible lines are drawn, so long scripts stay fast.
//
//   - syntax highlighting (SQL / PL/pgSQL, JSON, HTML with &ITEM. and {{tags}})
//   - line numbers, Tab / Shift+Tab indentation (Escape, then Tab leaves the field)
//   - auto-indent on Enter, bracket and quote pairing, matching bracket shown
//   - SQL completions (Ctrl+Space, or after "." ":" "&"): keywords, the app's
//     schemas, tables, views, columns (alias. too), functions, items as :binds
//     and &ITEM. substitutions, from GET /builder/code/completions
//   - a "Suggest" button opens the same list on touch screens
//   - "Check" plans the SQL like the Advisor (POST /builder/code/check)
//   - screen readers keep the plain textarea; the list is announced through
//     aria-activedescendant and a polite live region
//
// Strict CSP: no inline styles; geometry is set through the CSSOM. Suggestions
// and highlighted text are built as text nodes, never parsed as HTML.
(() => {
  'use strict';
  if (window.pgapexCodeEditor) return;

  const INDENT = '  ';
  const words = (s) => s.trim().split(/\s+/);
  const SQL_KW = new Set(words(`
    select from where and or not in is null like ilike between exists as on join inner left right full outer cross natural
    using group by order having limit offset fetch first next rows row only union all intersect except distinct case when
    then else end insert into values update set delete returning with recursive create table view materialized index replace
    drop alter add column constraint primary key foreign references unique check default cascade restrict truncate grant
    revoke to begin commit rollback savepoint do language function procedure returns return true false asc desc nulls last
    over partition window filter within lateral any some array cast collate escape similar current_user session_user
    current_date current_time current_timestamp localtime localtimestamp interval trigger before after for each execute
    schema sequence temporary temp if conflict nothing merge matched explain security definer invoker stable immutable
    volatile strict policy enable disable only extension`));
  // reserved words: identifiers named like these need quotes
  const RESERVED = new Set(words(`
    all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog
    current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except
    false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime
    localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric
    table then to trailing true union unique user using variadic when where window with`));
  const PLPGSQL_KW = new Set(words(`
    declare elsif elseif loop while foreach exit continue raise notice warning exception info debug log perform get
    diagnostics row_count query open close cursor constant alias out inout variadic call sqlstate sqlerrm assert found
    plpgsql reverse slice`));
  const TYPES = new Set(words(`
    integer int int2 int4 int8 bigint smallint numeric decimal real double precision float float4 float8 text varchar char
    character varying boolean bool date time timestamp timestamptz interval json jsonb uuid bytea serial bigserial record
    void setof regclass regtype oid money inet cidr xml tsvector tsquery point citext name`));
  const BUILTIN_FNS = words(`
    count sum avg min max coalesce nullif greatest least now date_trunc date_part extract to_char to_date to_number
    to_timestamp lower upper initcap trim ltrim rtrim btrim length char_length substr substring position strpos replace
    concat concat_ws string_agg array_agg array_length array_to_string string_to_array unnest json_agg jsonb_agg
    json_build_object jsonb_build_object json_object_agg jsonb_object_agg jsonb_set jsonb_array_elements
    jsonb_array_elements_text jsonb_each jsonb_each_text to_json to_jsonb row_to_json row_number rank dense_rank
    percent_rank ntile lag lead first_value last_value round trunc floor ceil abs mod power sqrt random format lpad rpad
    split_part regexp_replace regexp_matches regexp_match regexp_split_to_table left right reverse age
    generate_series md5 gen_random_uuid nextval currval setval pg_typeof current_setting set_config bool_and bool_or
    every exists cast date_bin make_date make_interval clock_timestamp statement_timestamp quote_ident quote_literal`);
  const BINDS_BUILTIN = [['APP_USER', 'signed-in user'], ['APP_ID', 'application id'], ['APP_ALIAS', 'application alias'],
    ['APP_PAGE_ID', 'page number'], ['APP_SESSION', 'session id'], ['REQUEST', 'button pressed'], ['APP_LANGUAGE', 'language']];
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  const CLOSE = { ')': '(', ']': '[', '}': '{' };
  const LANG_LABEL = { sql: 'SQL', plpgsql: 'PL/pgSQL', json: 'JSON', html: 'HTML', text: 'Text' };

  // ------------------------------------------------------------ lexers
  // Each returns parallel arrays: type, start, end. Text between tokens is
  // plain (whitespace, HTML text).

  const isWordStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
  const isWord = (c) => isWordStart(c) || (c >= 48 && c <= 57) || c === 36;
  const isDigit = (c) => c >= 48 && c <= 57;

  function lexSql(src, pl) {
    const T = [], S = [], E = [];
    const push = (t, s, e) => { T.push(t); S.push(s); E.push(e); };
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
      const next = src.charCodeAt(i + 1);
      if (c === 45 && next === 45) { // -- comment
        let e = src.indexOf('\n', i);
        if (e < 0) e = n;
        push('com', i, e); i = e; continue;
      }
      if (c === 47 && next === 42) { // /* comment */ (nested)
        let depth = 0, j = i;
        while (j < n) {
          if (src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 42) { depth++; j += 2; }
          else if (src.charCodeAt(j) === 42 && src.charCodeAt(j + 1) === 47) { depth--; j += 2; if (!depth) break; }
          else j++;
        }
        push('com', i, Math.min(j, n)); i = Math.min(j, n); continue;
      }
      if (c === 39 || ((c === 69 || c === 101) && next === 39 && !(i > 0 && isWord(src.charCodeAt(i - 1))))) { // 'string', E'string'
        const backslash = c !== 39;
        let j = backslash ? i + 2 : i + 1;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (backslash && d === 92) { j += 2; continue; }
          if (d === 39) { if (src.charCodeAt(j + 1) === 39) { j += 2; continue; } j++; break; }
          j++;
        }
        push('str', i, Math.min(j, n)); i = Math.min(j, n); continue;
      }
      if (c === 34) { // "quoted identifier"
        let j = i + 1;
        while (j < n) {
          if (src.charCodeAt(j) === 34) { if (src.charCodeAt(j + 1) === 34) { j += 2; continue; } j++; break; }
          j++;
        }
        push('qid', i, Math.min(j, n)); i = Math.min(j, n); continue;
      }
      if (c === 36) { // $tag$ (dollar quote delimiter; the body is highlighted as code) or $1
        if (isDigit(next)) { let j = i + 1; while (j < n && isDigit(src.charCodeAt(j))) j++; push('bind', i, j); i = j; continue; }
        const m = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
        m.lastIndex = i;
        if (m.test(src)) { push('dol', i, m.lastIndex); i = m.lastIndex; continue; }
        push('op', i, i + 1); i++; continue;
      }
      if (isDigit(c) || (c === 46 && isDigit(next))) {
        const m = /\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.?/y;
        m.lastIndex = i; m.test(src);
        push('num', i, m.lastIndex || i + 1); i = m.lastIndex || i + 1; continue;
      }
      if (c === 58) { // :: cast, := assignment, :NAME bind
        if (next === 58 || next === 61) { push('op', i, i + 2); i += 2; continue; }
        if (isWordStart(next) && !(i > 0 && src.charCodeAt(i - 1) === 58)) {
          let j = i + 1; while (j < n && isWord(src.charCodeAt(j))) j++;
          push('bind', i, j); i = j; continue;
        }
        push('op', i, i + 1); i++; continue;
      }
      if (c === 38 && isWordStart(next)) { // &ITEM. substitution
        const m = /&[A-Za-z][A-Za-z0-9_]*(?:\$[A-Za-z0-9_.-]+?)?\./y;
        m.lastIndex = i;
        if (m.test(src)) { push('sub', i, m.lastIndex); i = m.lastIndex; continue; }
      }
      if (isWordStart(c)) {
        let j = i + 1; while (j < n && isWord(src.charCodeAt(j))) j++;
        const w = src.slice(i, j).toLowerCase();
        let k = j; while (k < n && src.charCodeAt(k) === 32) k++;
        const call = src.charCodeAt(k) === 40;
        const t = SQL_KW.has(w) || (pl && PLPGSQL_KW.has(w)) ? (call && !SQL_KW.has(w) ? 'fn' : 'kw')
          : TYPES.has(w) ? 'type' : call ? 'fn' : 'id';
        push(t, i, j); i = j; continue;
      }
      if (OPEN[src[i]] || CLOSE[src[i]]) { push('br', i, i + 1); i++; continue; }
      push(c === 44 || c === 59 || c === 46 ? 'pun' : 'op', i, i + 1); i++;
    }
    return { T, S, E };
  }

  function lexJson(src) {
    const T = [], S = [], E = [];
    const push = (t, s, e) => { T.push(t); S.push(s); E.push(e); };
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
      if (c === 34) {
        let j = i + 1;
        while (j < n) { const d = src.charCodeAt(j); if (d === 92) { j += 2; continue; } if (d === 34 || d === 10) { j++; break; } j++; }
        j = Math.min(j, n);
        let k = j; while (k < n && /\s/.test(src[k])) k++;
        push(src[k] === ':' ? 'key' : 'str', i, j); i = j; continue;
      }
      if (c === 45 || isDigit(c)) {
        const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y; m.lastIndex = i;
        if (m.test(src)) { push('num', i, m.lastIndex); i = m.lastIndex; continue; }
      }
      if (isWordStart(c)) {
        let j = i + 1; while (j < n && isWord(src.charCodeAt(j))) j++;
        const w = src.slice(i, j);
        push(w === 'true' || w === 'false' || w === 'null' ? 'kw' : 'err', i, j); i = j; continue;
      }
      if (OPEN[src[i]] || CLOSE[src[i]]) { push('br', i, i + 1); i++; continue; }
      push(c === 44 || c === 58 ? 'pun' : 'err', i, i + 1); i++;
    }
    return { T, S, E };
  }

  function lexHtml(src) {
    const T = [], S = [], E = [];
    const push = (t, s, e) => { if (e > s) { T.push(t); S.push(s); E.push(e); } };
    const n = src.length;
    const sticky = (re, at) => { re.lastIndex = at; return re.test(src) ? re.lastIndex : -1; };
    const SUB = /&[A-Za-z][A-Za-z0-9_]*(?:\$[A-Za-z0-9_.-]+?)?\./y;
    const ENT = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/y;
    const MUSTACHE = /\{\{[\s\S]*?\}\}/y;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === '<' && src.startsWith('<!--', i)) {
        let e = src.indexOf('-->', i + 4); e = e < 0 ? n : e + 3;
        push('com', i, e); i = e; continue;
      }
      if (c === '<' && /[A-Za-z/!?]/.test(src[i + 1] || '')) {
        let j = sticky(/<\/?[!?]?[A-Za-z0-9-]*/y, i);
        push('tag', i, j); i = j;
        while (i < n) { // attributes until > (or the next < when a tag isn't closed)
          const d = src[i];
          if (/\s/.test(d)) { i++; continue; }
          if (d === '>' || (d === '/' && src[i + 1] === '>')) { const e = d === '>' ? i + 1 : i + 2; push('tag', i, e); i = e; break; }
          if (d === '<') break;
          if (d === '=') { push('op', i, i + 1); i++; continue; }
          if (d === '"' || d === "'") {
            let e = src.indexOf(d, i + 1); e = e < 0 ? n : e + 1;
            push('str', i, e); i = e; continue;
          }
          j = sticky(/[^\s=>"'<]+/y, i);
          push(src[i - 1] === '=' ? 'str' : 'attr', i, j); i = j;
        }
        continue;
      }
      if (c === '&') {
        let e = sticky(SUB, i);
        if (e > 0) { push('sub', i, e); i = e; continue; }
        e = sticky(ENT, i);
        if (e > 0) { push('ent', i, e); i = e; continue; }
      }
      if (c === '{' && src[i + 1] === '{') {
        const e = sticky(MUSTACHE, i);
        if (e > 0) { push('sub', i, e); i = e; continue; }
      }
      // plain text up to the next interesting character
      let j = i + 1;
      while (j < n && !'<&{'.includes(src[j])) j++;
      i = j;
    }
    return { T, S, E };
  }

  const lex = (lang, src) =>
    lang === 'sql' || lang === 'plpgsql' ? lexSql(src, lang === 'plpgsql')
      : lang === 'json' ? lexJson(src) : lang === 'html' ? lexHtml(src) : { T: [], S: [], E: [] };

  // ------------------------------------------------------------ completion data
  // One request per page, on first use. The builder URL tells which app.
  let dataPromise = null;
  function scope() {
    const m = /^\/builder\/(apps|pages)\/(\d+)/.exec(location.pathname);
    return m ? { [m[1] === 'apps' ? 'app' : 'page']: m[2] } : {};
  }
  function completionData() {
    if (!dataPromise) {
      const q = new URLSearchParams(scope()).toString();
      dataPromise = fetch(`/builder/code/completions${q ? `?${q}` : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null))
        .catch(() => null)
        .then((d) => d && prepare(d));
    }
    return dataPromise;
  }
  function prepare(d) {
    const rels = (d.relations || []).map((r) => ({ ...r, columns: r.columns || [] }));
    const byName = new Map();
    for (const r of rels) {
      const k = r.name.toLowerCase();
      if (!byName.has(k) || r.schema === 'public') byName.set(k, r);
    }
    return { ...d, relations: rels, byName, schemaSet: new Set((d.schemas || []).map((s) => s.toLowerCase())) };
  }

  const PLAIN_ID = /^[a-z_][a-z0-9_$]*$/;
  const quoteId = (s) => (PLAIN_ID.test(s) && !RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`);
  const unquote = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());
  const qualified = (schema, name) => (schema === 'public' ? quoteId(name) : `${quoteId(schema)}.${quoteId(name)}`);

  /** Tables named in FROM / JOIN / UPDATE / INTO, with their aliases. */
  function relationsInText(text, toks, data) {
    const { T, S, E } = toks;
    const found = []; // { rel, alias }
    const word = (k) => (k < T.length && (T[k] === 'id' || T[k] === 'qid' || T[k] === 'fn' || T[k] === 'type') ? text.slice(S[k], E[k]) : null);
    for (let k = 0; k < T.length; k++) {
      if (T[k] !== 'kw') continue;
      const kw = text.slice(S[k], E[k]).toLowerCase();
      if (!['from', 'join', 'update', 'into'].includes(kw)) continue;
      let j = k + 1;
      for (;;) {
        if (T[j] === 'kw' && text.slice(S[j], E[j]).toLowerCase() === 'only') j++;
        let a = word(j);
        if (!a) break;
        let schema = null, name = unquote(a);
        j++;
        if (T[j] === 'pun' && text[S[j]] === '.' && word(j + 1)) { schema = name; name = unquote(word(j + 1)); j += 2; }
        let alias = null;
        if (T[j] === 'kw' && text.slice(S[j], E[j]).toLowerCase() === 'as') j++;
        if (word(j)) { alias = unquote(word(j)); j++; }
        const rel = schema
          ? data.relations.find((r) => r.schema.toLowerCase() === schema && r.name.toLowerCase() === name)
          : data.byName.get(name);
        if (rel) found.push({ rel, alias });
        if (kw === 'from' && T[j] === 'pun' && text[S[j]] === ',') { j++; continue; }
        break;
      }
    }
    return found;
  }

  /** Suggestions at the caret: { from, prefix, list: [{label, insert, detail, kind}] } or null. */
  async function suggestionsAt(ed, explicit) {
    const ta = ed.ta;
    const text = ta.value;
    ed.sync();
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return null;
    const lang = ed.lang;
    if (lang === 'text') return null;
    let ws = caret;
    while (ws > 0 && isWord(text.charCodeAt(ws - 1))) ws--;
    const prefix = text.slice(ws, caret);
    const before = text[ws - 1] || '';
    const tokAt = ed.tokenAt(Math.max(0, ws - 1));
    const inString = tokAt && (tokAt.t === 'str' || tokAt.t === 'key') && tokAt.s < ws && (tokAt.e > caret || !/['"]$/.test(text.slice(tokAt.s, tokAt.e)));
    const inComment = tokAt && tokAt.t === 'com' && tokAt.s < ws;
    if (inComment) return null;
    const data = await completionData();
    const items = data ? data.items || [] : [];
    const page = data && data.page;
    const itemList = (wrap) => [
      ...items.map((it) => ({ label: it.name, insert: wrap(it.name), kind: 'item', detail: it.page === null || it.page === undefined ? 'application item' : `page ${it.page} item`, rank: it.page === page ? 0 : it.page === null ? 1 : 2 })),
      ...BINDS_BUILTIN.map(([n, d]) => ({ label: n, insert: wrap(n), kind: 'builtin', detail: d, rank: 3 })),
    ];
    // &ITEM. substitutions (HTML, JSON, and SQL text)
    if (before === '&') return { from: ws - 1, prefix, list: itemList((n) => `&${n}.`) };
    if (lang === 'html' || lang === 'json') {
      if (lang === 'json' && inString && before === ':' && text[ws - 2] !== ':') return { from: ws - 1, prefix, list: itemList((n) => `:${n}`) };
      return null;
    }
    // SQL and PL/pgSQL
    if (inString) return null;
    if (before === ':' && text[ws - 2] !== ':') return { from: ws - 1, prefix, list: itemList((n) => `:${n}`) };
    if (!data && !explicit && !prefix) return null;
    const list = [];
    if (before === '.') {
      // qualifier: alias., table., schema., schema.table.
      const head = /(?:("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\.)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\.$/.exec(text.slice(Math.max(0, ws - 200), ws));
      if (!head || !data) return null;
      const q = unquote(head[2]);
      const q0 = head[1] ? unquote(head[1]) : null;
      let rel = null;
      if (q0) rel = data.relations.find((r) => r.schema.toLowerCase() === q0 && r.name.toLowerCase() === q);
      else {
        const inText = relationsInText(text, ed.toks, data);
        rel = (inText.find((x) => x.alias === q) || inText.find((x) => x.rel.name.toLowerCase() === q) || {}).rel || null;
        if (!rel && !data.schemaSet.has(q)) rel = data.byName.get(q) || null;
      }
      if (rel) {
        for (const c of rel.columns) list.push({ label: c.name, insert: quoteId(c.name), kind: 'column', detail: c.type, rank: 0 });
      } else if (!q0 && data.schemaSet.has(q)) {
        for (const r of data.relations) if (r.schema.toLowerCase() === q) list.push({ label: r.name, insert: quoteId(r.name), kind: r.kind, detail: `${r.kind} · ${r.columns.length} columns`, rank: 0 });
        for (const f of data.functions || []) if (f.schema.toLowerCase() === q) list.push({ label: f.name, insert: `${quoteId(f.name)}(`, kind: 'function', detail: `(${f.args}) → ${f.returns}`, rank: 1 });
      }
      return { from: ws, prefix, list };
    }
    if (!prefix && !explicit) return null;
    if (data) {
      const inText = relationsInText(text, ed.toks, data);
      const seen = new Set();
      for (const { rel, alias } of inText) {
        for (const c of rel.columns) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          list.push({ label: c.name, insert: quoteId(c.name), kind: 'column', detail: `${c.type} · ${alias || rel.name}`, rank: 0 });
        }
        if (alias) list.push({ label: alias, insert: alias, kind: 'alias', detail: `${rel.schema}.${rel.name}`, rank: 1 });
      }
      for (const r of data.relations) list.push({ label: r.name, insert: qualified(r.schema, r.name), kind: r.kind, detail: `${r.schema}.${r.name}`, rank: 2 });
      for (const s of data.schemas || []) list.push({ label: s, insert: `${quoteId(s)}.`, kind: 'schema', detail: 'schema', rank: 3, reopen: true });
      for (const f of data.functions || []) list.push({ label: f.name, insert: `${qualified(f.schema, f.name)}(`, kind: 'function', detail: `${f.schema} (${f.args}) → ${f.returns}`, rank: 4 });
    }
    const upper = prefix && prefix === prefix.toUpperCase() && /[A-Z]/.test(prefix);
    const kcase = (w) => (upper ? w.toUpperCase() : w);
    for (const f of BUILTIN_FNS) list.push({ label: f, insert: `${kcase(f)}(`, kind: 'function', detail: 'built-in function', rank: 5 });
    for (const k of SQL_KW) list.push({ label: k, insert: kcase(k), kind: 'keyword', detail: 'keyword', rank: 6 });
    if (lang === 'plpgsql') for (const k of PLPGSQL_KW) if (!SQL_KW.has(k)) list.push({ label: k, insert: kcase(k), kind: 'keyword', detail: 'PL/pgSQL', rank: 6 });
    for (const t of TYPES) list.push({ label: t, insert: kcase(t), kind: 'type', detail: 'type', rank: 7 });
    return { from: ws, prefix, list };
  }

  /** Filter and rank by the typed prefix: starts with, then a word part, then contains. */
  function rank(list, prefix) {
    const p = prefix.toLowerCase();
    const out = [];
    const seen = new Set();
    for (const s of list) {
      const l = s.label.toLowerCase();
      let score;
      if (!p) score = 0;
      else if (l.startsWith(p)) score = l === p ? -1 : 0;
      else if (l.includes(`_${p}`)) score = 1;
      else if (p.length > 1 && l.includes(p)) score = 2;
      else continue;
      const key = `${s.kind}:${s.insert}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ s, score });
    }
    out.sort((a, b) => a.score - b.score || a.s.rank - b.s.rank || a.s.label.localeCompare(b.s.label));
    return out.slice(0, 80).map((x) => x.s);
  }

  // ------------------------------------------------------------ the editor
  let uid = 0;

  class Editor {
    constructor(ta) {
      this.ta = ta;
      this.id = `ce${++uid}`;
      this.base = ta.dataset.code;
      this.lang = this.base in LANG_LABEL ? this.base : 'text';
      this.text = null;
      this.toks = { T: [], S: [], E: [] };
      this.lineStarts = [0];
      this.match = null;
      this.pop = null; // open completion: { from, items, active, explicit }
      this.escaped = false;
      this.frame = 0;
      this.build();
      this.bind();
      this.schedule();
    }

    build() {
      const ta = this.ta;
      const wrap = document.createElement('div');
      wrap.className = 'ce';
      wrap.dataset.lang = this.lang;
      const gutter = document.createElement('div');
      gutter.className = 'ce-gutter';
      gutter.setAttribute('aria-hidden', 'true');
      const nums = document.createElement('div');
      nums.className = 'ce-nums';
      gutter.append(nums);
      const main = document.createElement('div');
      main.className = 'ce-main';
      const hl = document.createElement('div');
      hl.className = 'ce-hl';
      hl.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('pre');
      inner.className = 'ce-code';
      hl.append(inner);
      ta.parentNode.insertBefore(wrap, ta);
      main.append(hl, ta);
      wrap.append(gutter, main);
      ta.classList.add('ce-input');
      ta.setAttribute('wrap', 'off');
      ta.spellcheck = false;
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('autocorrect', 'off');

      // completion popup (listbox), status line, hint
      const list = document.createElement('ul');
      list.className = 'ce-pop';
      list.id = `${this.id}-list`;
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Suggestions');
      list.hidden = true;
      wrap.append(list);
      const bar = document.createElement('div');
      bar.className = 'ce-bar';
      const lang = document.createElement('span');
      lang.className = 'ce-lang';
      const hint = document.createElement('span');
      hint.className = 'ce-hint';
      hint.id = `${this.id}-hint`;
      const pos = document.createElement('span');
      pos.className = 'ce-pos';
      pos.setAttribute('aria-hidden', 'true');
      const msg = document.createElement('span');
      msg.className = 'ce-msg';
      msg.setAttribute('role', 'status');
      // the textarea keeps the focus while the list is open; screen readers
      // hear the list through this live region (and aria-activedescendant)
      const live = document.createElement('span');
      live.className = 'sr-only';
      live.setAttribute('aria-live', 'polite');
      // a touch screen has no Ctrl+Space
      const suggest = document.createElement('button');
      suggest.type = 'button';
      suggest.className = 'btn ce-suggest';
      suggest.textContent = 'Suggest';
      suggest.title = 'Suggestions at the cursor (Ctrl+Space)';
      suggest.setAttribute('aria-controls', list.id);
      suggest.setAttribute('aria-expanded', 'false');
      bar.append(lang, hint, pos, suggest);
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'btn ce-check';
      check.textContent = 'Check';
      check.title = 'Plan the SQL as the application’s role, like the Advisor (nothing runs)';
      bar.append(check, msg);
      wrap.append(bar, live);
      ta.setAttribute('aria-describedby', [ta.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
      ta.setAttribute('aria-autocomplete', 'list');
      ta.setAttribute('aria-haspopup', 'listbox');
      ta.setAttribute('aria-controls', list.id);
      Object.assign(this, { wrap, gutter, nums, main, hl, inner, list, bar, langEl: lang, hint, pos, msg, check, live, suggest });
      this.applyLang();
    }

    applyLang() {
      this.wrap.dataset.lang = this.lang;
      this.langEl.textContent = LANG_LABEL[this.lang];
      const sql = this.lang === 'sql' || this.lang === 'plpgsql';
      this.hint.textContent = (sql ? 'Ctrl+Space: suggestions · ' : this.lang === 'html' ? 'Type & for items · ' : '') + 'Tab indents · Esc, Tab: next field';
      this.check.hidden = !(sql && this.ta.dataset.codeCheck);
      this.suggest.hidden = !(sql || this.lang === 'html' || this.lang === 'json');
      this.msg.textContent = '';
      this.text = null;
    }

    bind() {
      const ta = this.ta;
      ta.addEventListener('input', () => { this.schedule(); this.afterInput(); });
      ta.addEventListener('scroll', () => this.schedule(true));
      ta.addEventListener('keydown', (e) => this.keydown(e));
      ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) this.close(); }, 120));
      for (const ev of ['keyup', 'mouseup', 'focus', 'select']) ta.addEventListener(ev, () => this.caretMoved());
      ta.addEventListener('mousedown', () => this.close());
      // another script setting .value (file → textarea, form reset) redraws too
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      const self = this;
      Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); self.schedule(); },
      });
      ta.form?.addEventListener('reset', () => setTimeout(() => this.schedule()));
      if ('ResizeObserver' in window) new ResizeObserver(() => this.schedule(true)).observe(ta);
      this.list.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep the focus in the textarea
        const li = e.target.closest('[role=option]');
        if (li) this.accept(Number(li.dataset.i));
      });
      this.list.addEventListener('mousemove', (e) => {
        const li = e.target.closest('[role=option]');
        if (li && this.pop && Number(li.dataset.i) !== this.pop.active) this.setActive(Number(li.dataset.i), false);
      });
      this.check.addEventListener('click', () => this.runCheck());
      // keep the textarea's caret: the button must not take the focus on a tap
      this.suggest.addEventListener('mousedown', (e) => e.preventDefault());
      this.suggest.addEventListener('click', () => {
        if (this.pop) { this.close(); return; }
        this.ta.focus();
        this.open(true);
      });
      // language follows the component's type ("type:static=html,form=text,*=sql")
      const sw = ta.dataset.codeSwitch;
      const field = sw && ta.form && ta.form.elements.namedItem(sw.split(':')[0]);
      if (field && field.addEventListener) {
        const map = Object.fromEntries(sw.split(':')[1].split(',').map((p) => p.split('=')));
        const update = () => {
          const lang = map[field.value] || map['*'] || this.base;
          if (lang !== this.lang) { this.lang = lang in LANG_LABEL ? lang : 'text'; ta.dataset.code = this.lang; this.applyLang(); this.schedule(); }
        };
        field.addEventListener('change', update);
        update();
      }
      // the Advisor check follows it too ("action:set_value=select,*=statements"; none: no check)
      const csw = ta.dataset.codeCheckSwitch;
      const cfield = csw && ta.form && ta.form.elements.namedItem(csw.split(':')[0]);
      if (cfield && cfield.addEventListener) {
        const map = Object.fromEntries(csw.split(':')[1].split(',').map((p) => p.split('=')));
        const update = () => {
          const shape = map[cfield.value] || map['*'];
          if (shape && shape !== 'none') ta.dataset.codeCheck = shape;
          else delete ta.dataset.codeCheck;
          this.applyLang();
        };
        cfield.addEventListener('change', update);
        update();
      }
    }

    // -------------------------------------------------------- drawing
    schedule(scrollOnly) {
      if (!scrollOnly) this.dirty = true;
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
    }

    metrics() {
      const cs = getComputedStyle(this.ta);
      const lh = parseFloat(cs.lineHeight) || 20;
      if (!this.cw || this.cwFont !== cs.font) {
        const probe = document.createElement('span');
        probe.textContent = '0'.repeat(50);
        this.inner.append(probe);
        this.cw = probe.getBoundingClientRect().width / 50 || 8;
        probe.remove();
        this.cwFont = cs.font;
      }
      return { lh, padTop: parseFloat(cs.paddingTop) || 0, padLeft: parseFloat(cs.paddingLeft) || 0 };
    }

    /** Lex again when the text changed. */
    sync() {
      const text = this.ta.value;
      if (text === this.text) return text;
      this.text = text;
      this.toks = lex(this.lang, text);
      const starts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      this.lineStarts = starts;
      this.updateMatch();
      return text;
    }

    render() {
      const ta = this.ta;
      const text = this.sync();
      const { lh } = this.metrics();
      const lines = this.lineStarts.length;
      const first = Math.max(0, Math.floor(ta.scrollTop / lh) - 2);
      const last = Math.min(lines - 1, first + Math.ceil(ta.clientHeight / lh) + 4);
      // the highlighted copy of the visible lines
      const startOff = this.lineStarts[first];
      const endOff = last + 1 < lines ? this.lineStarts[last + 1] : text.length;
      const { T, S, E } = this.toks;
      let k = lowerBound(E, startOff + 1);
      const frag = document.createDocumentFragment();
      let pos = startOff;
      const m = this.match;
      while (pos < endOff) {
        if (k < T.length && S[k] < endOff) {
          const s = Math.max(S[k], pos);
          if (s > pos) frag.append(text.slice(pos, s));
          const e = Math.min(E[k], endOff);
          if (e > s) {
            const span = document.createElement('span');
            span.className = `t-${T[k]}${m && (S[k] === m[0] || S[k] === m[1]) ? ' t-match' : ''}`;
            span.textContent = text.slice(s, e);
            frag.append(span);
          }
          pos = Math.max(e, pos);
          k++;
        } else {
          frag.append(text.slice(pos, endOff));
          pos = endOff;
        }
      }
      frag.append('\n ');
      this.inner.replaceChildren(frag);
      const y = first * lh - ta.scrollTop;
      this.inner.style.transform = `translate(${-ta.scrollLeft}px, ${y}px)`;
      // line numbers
      let nums = '';
      for (let i = first; i <= last; i++) nums += `${i + 1}\n`;
      this.nums.textContent = nums;
      this.nums.style.transform = `translateY(${y}px)`;
      const digits = String(lines).length;
      if (digits !== this.digits) {
        this.digits = digits;
        this.gutter.style.setProperty('--ce-digits', String(Math.max(2, digits)));
      }
      if (this.pop) this.place();
    }

    tokenAt(off) {
      this.sync();
      const { T, S, E } = this.toks;
      const k = lowerBound(E, off + 1);
      return k < T.length && S[k] <= off ? { t: T[k], s: S[k], e: E[k] } : null;
    }

    // the bracket next to the caret and its partner
    updateMatch() {
      const ta = this.ta;
      const old = this.match;
      this.match = null;
      if (ta.selectionStart === ta.selectionEnd && document.activeElement === ta) {
        const { T, S } = this.toks;
        const text = this.text ?? '';
        const caret = ta.selectionStart;
        for (const off of [caret - 1, caret]) {
          const k = lowerBound(S, off);
          if (k >= T.length || S[k] !== off || T[k] !== 'br') continue;
          const ch = text[off];
          const fwd = !!OPEN[ch];
          const partner = fwd ? OPEN[ch] : CLOSE[ch];
          let depth = 0;
          for (let j = k; fwd ? j < T.length : j >= 0; j += fwd ? 1 : -1) {
            if (T[j] !== 'br') continue;
            const c2 = text[S[j]];
            if (c2 === ch) depth++;
            else if (c2 === partner && --depth === 0) { this.match = [off, S[j]]; break; }
          }
          if (this.match) break;
        }
      }
      return String(old) !== String(this.match);
    }

    caretMoved() {
      this.sync();
      if (this.pop && this.ta.selectionStart !== this.ta.selectionEnd) this.close();
      if (this.updateMatch()) this.schedule(true);
      const c = this.ta.selectionStart;
      const line = lowerBound(this.lineStarts, c + 1);
      this.pos.textContent = `Ln ${line}, Col ${c - this.lineStarts[line - 1] + 1}`;
    }

    // -------------------------------------------------------- editing
    /** Replace [start, end) with text through the browser's editing (keeps undo), then select. */
    edit(start, end, text, selStart, selEnd) {
      const ta = this.ta;
      ta.focus();
      ta.setSelectionRange(start, end);
      let ok = false;
      try { ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete'); } catch { ok = false; }
      if (!ok) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
    }

    keydown(e) {
      const ta = this.ta;
      if (ta.readOnly || ta.disabled || e.isComposing) return;
      const pop = this.pop;
      if (pop) {
        const n = pop.items.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.setActive((pop.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n, true); pop.explicit = true; return; }
        if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); this.setActive(Math.max(0, Math.min(n - 1, pop.active + (e.key === 'PageDown' ? 8 : -8))), true); pop.explicit = true; return; }
        const collapsed = ta.selectionStart === ta.selectionEnd;
        if (collapsed && ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && pop.explicit)) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.accept(pop.active); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
        // anything else that isn't typing (Shift+Tab, Ctrl+A, Home, …) closes the list
        if (!collapsed || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
          if (!(e.key === ' ' && (e.ctrlKey || e.metaKey)) && !['Shift', 'Control', 'Meta', 'Alt', 'Backspace'].includes(e.key)) this.close();
        }
      }
      if (e.key === ' ' && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); this.open(true); return; }
      if (e.key === 'Escape') { this.escaped = true; return; }
      if (e.key === 'Tab') {
        if (this.escaped || e.ctrlKey || e.altKey || e.metaKey) { this.escaped = false; return; }
        e.preventDefault();
        this.indent(e.shiftKey);
        return;
      }
      this.escaped = false;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
      if (e.key === 'Enter') {
        e.preventDefault();
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const ind = /^[ \t]*/.exec(v.slice(ls, s))[0];
        const prev = v.slice(ls, s).replace(/--.*$/, '').trimEnd();
        const nextCh = v[en];
        const opens = /[([{]$/.test(prev) || (this.lang !== 'json' && this.lang !== 'html' && /\b(begin|loop|then|else|declare|as \$\w*\$)$/i.test(prev));
        if (/[([{]$/.test(prev) && nextCh === OPEN[prev.slice(-1)]) {
          const mid = `\n${ind}${INDENT}`;
          this.edit(s, en, `${mid}\n${ind}`, s + mid.length);
        } else {
          const ins = `\n${ind}${opens ? INDENT : ''}`;
          this.edit(s, en, ins, s + ins.length);
        }
        return;
      }
      if (e.key === 'Backspace' && s === en && s > 0) {
        const a = v[s - 1], b = v[s];
        if ((OPEN[a] && OPEN[a] === b) || ((a === "'" || a === '"') && a === b)) { e.preventDefault(); this.edit(s - 1, s + 1, ''); return; }
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const lead = v.slice(ls, s);
        if (lead.length >= INDENT.length && /^ +$/.test(lead)) {
          e.preventDefault();
          const cut = ((lead.length - 1) % INDENT.length) + 1;
          this.edit(s - cut, s, '');
        }
        return;
      }
      if (e.key.length !== 1) return;
      const ch = e.key;
      const next = v[en];
      // typing a closer that is already there steps over it
      if ((CLOSE[ch] || ch === "'" || ch === '"') && s === en && next === ch && this.lang !== 'text') { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); this.caretMoved(); return; }
      const pairable = this.lang !== 'text' && (OPEN[ch] || ((ch === "'" || ch === '"') && !(this.lang === 'json' && ch === "'")));
      if (!pairable) return;
      const close = OPEN[ch] || ch;
      if (s !== en) { // wrap the selection
        e.preventDefault();
        this.edit(s, en, ch + v.slice(s, en) + close, s + 1, en + 1);
        return;
      }
      const prevCh = v[s - 1] || '';
      if (ch === "'" || ch === '"') {
        if (/[\w$'"]/.test(prevCh)) return; // E'..', it's, closing quote
        const tok = this.tokenAt(Math.max(0, s - 1));
        if (tok && (tok.t === 'str' || tok.t === 'com' || tok.t === 'qid' || tok.t === 'key') && tok.e >= s && tok.s < s) return;
      }
      if (next === undefined || /[\s)\]},;]/.test(next)) {
        e.preventDefault();
        this.edit(s, en, ch + close, s + 1);
      }
    }

    indent(out) {
      const ta = this.ta;
      const v = ta.value;
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s === en && !out) { // spaces up to the next stop
        const col = s - (v.lastIndexOf('\n', s - 1) + 1);
        const pad = INDENT.slice(col % INDENT.length) || INDENT;
        this.edit(s, en, pad, s + pad.length);
        return;
      }
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      let le = v.indexOf('\n', en > s && v[en - 1] === '\n' ? en - 1 : en);
      if (le < 0) le = v.length;
      const lines = v.slice(ls, le).split('\n');
      const deltas = [];
      const changed = lines.map((l) => {
        if (out) {
          const m = /^(?: {1,2}|\t)/.exec(l);
          deltas.push(m ? -m[0].length : 0);
          return m ? l.slice(m[0].length) : l;
        }
        if (!l.length && lines.length > 1) { deltas.push(0); return l; }
        deltas.push(INDENT.length);
        return INDENT + l;
      });
      const total = deltas.reduce((a, b) => a + b, 0);
      if (!total) return;
      const ns = s === ls && s !== en ? ls : Math.max(ls, s + deltas[0]);
      this.edit(ls, le, changed.join('\n'), ns, s === en ? ns : en + total);
    }

    // -------------------------------------------------------- completion popup
    afterInput() {
      const ta = this.ta;
      const v = ta.value;
      const c = ta.selectionStart;
      const ch = v[c - 1];
      if (this.pop) {
        if (ch !== undefined && isWord(ch.charCodeAt(0))) { this.open(this.pop.explicit, true); return; }
        this.close();
      }
      if (this.lang === 'text' || ta.selectionStart !== ta.selectionEnd) return;
      const sql = this.lang === 'sql' || this.lang === 'plpgsql';
      if (ch === '&' || (sql && ch === '.' && /[\w"]/.test(v[c - 2] || '')) || ((sql || this.lang === 'json') && ch === ':' && v[c - 2] !== ':' && /[\s(,=<>!]/.test(v[c - 2] || ' ')))
        this.open(true);
      else if (sql && /\w/.test(ch || '') && /(^|[^\w$.:&])[A-Za-z_]\w{2}$/.test(v.slice(Math.max(0, c - 5), c)))
        this.open(false);
    }

    async open(explicit, refresh) {
      const req = (this.req = (this.req || 0) + 1);
      const r = await suggestionsAt(this, explicit);
      if (req !== this.req) return; // a newer request won
      const caret = this.ta.selectionStart;
      if (!r || document.activeElement !== this.ta || caret < r.from) { this.close(); return; }
      const items = rank(r.list, this.ta.value.slice(r.from, caret).replace(/^[:&]/, ''));
      // nothing (or only what is already typed) to offer
      if (!items.length || (!explicit && items.length === 1 && items[0].label.toLowerCase() === r.prefix.toLowerCase())) { this.close(); return; }
      const prevLabel = refresh && this.pop ? this.pop.items[this.pop.active]?.label : null;
      this.pop = { from: r.from, items, active: 0, explicit: explicit || (refresh && this.pop?.explicit) };
      const keep = prevLabel ? items.findIndex((x) => x.label === prevLabel) : -1;
      if (keep > 0) this.pop.active = keep;
      this.drawList();
      const first = items[this.pop.active];
      this.say(`${items.length} suggestion${items.length === 1 ? '' : 's'}: ${first.label}, ${first.detail || first.kind}. Up and down arrows to choose, Enter or Tab to insert, Escape to close.`, refresh);
    }

    drawList() {
      const { items, active } = this.pop;
      const frag = document.createDocumentFragment();
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.id = `${this.id}-o${i}`;
        li.setAttribute('role', 'option');
        li.dataset.i = String(i);
        li.className = `ce-opt ce-k-${it.kind}`;
        li.setAttribute('aria-selected', String(i === active));
        const label = document.createElement('span');
        label.className = 'ce-opt-label';
        label.textContent = it.label;
        const detail = document.createElement('span');
        detail.className = 'ce-opt-detail';
        detail.textContent = it.detail || '';
        li.append(label, detail);
        frag.append(li);
      });
      this.list.replaceChildren(frag);
      this.list.hidden = false;
      this.ta.setAttribute('aria-activedescendant', `${this.id}-o${active}`);
      this.wrap.classList.add('ce-open');
      this.suggest.setAttribute('aria-expanded', 'true');
      this.place();
      this.list.children[active]?.scrollIntoView({ block: 'nearest' });
    }

    setActive(i, scroll) {
      const prev = this.list.children[this.pop.active];
      prev?.setAttribute('aria-selected', 'false');
      this.pop.active = i;
      const li = this.list.children[i];
      li?.setAttribute('aria-selected', 'true');
      this.ta.setAttribute('aria-activedescendant', li ? li.id : '');
      if (scroll) li?.scrollIntoView({ block: 'nearest' });
      const it = this.pop.items[i];
      if (it) this.say(`${it.label}, ${it.detail || it.kind}`);
    }

    /** Tell screen readers (polite; a refresh while typing only when the count changed). */
    say(text, refresh) {
      if (refresh) {
        const n = this.pop ? this.pop.items.length : 0;
        if (n === this.saidCount) return;
        text = `${n} suggestion${n === 1 ? '' : 's'}`;
      }
      this.saidCount = this.pop ? this.pop.items.length : 0;
      clearTimeout(this.sayTimer);
      this.sayTimer = setTimeout(() => { this.live.textContent = text; }, 60);
    }

    place() {
      const ta = this.ta;
      const v = ta.value;
      const c = this.pop ? this.pop.from : ta.selectionStart;
      const { lh, padTop, padLeft } = this.metrics();
      const ls = v.lastIndexOf('\n', c - 1) + 1;
      const line = this.lineStarts.length > 1 ? lowerBound(this.lineStarts, ls + 1) - 1 : 0;
      const col = v.slice(ls, c).replace(/\t/g, '  ').length;
      const gw = this.gutter.offsetWidth;
      const maxX = Math.max(0, this.wrap.clientWidth - this.list.offsetWidth - 4);
      const x = Math.max(0, Math.min(maxX, gw + padLeft + col * this.cw - ta.scrollLeft - 6));
      const y = Math.max(0, Math.min(ta.clientHeight, padTop + (line + 1) * lh - ta.scrollTop) + 2);
      this.list.style.left = `${Math.round(x)}px`;
      this.list.style.top = `${Math.round(y)}px`;
    }

    accept(i) {
      const pop = this.pop;
      if (!pop) return;
      const it = pop.items[i];
      const caret = this.ta.selectionStart;
      this.close();
      if (!it) return;
      // replace the typed word (and the rest of the identifier after the caret)
      let end = caret;
      const v = this.ta.value;
      while (end < v.length && isWord(v.charCodeAt(end))) end++;
      this.edit(pop.from, end, it.insert, pop.from + it.insert.length);
      if (it.reopen) this.open(true);
    }

    close() {
      this.req = (this.req || 0) + 1;
      if (!this.pop) return;
      this.pop = null;
      this.list.hidden = true;
      this.list.replaceChildren();
      this.wrap.classList.remove('ce-open');
      this.suggest.setAttribute('aria-expanded', 'false');
      this.ta.removeAttribute('aria-activedescendant');
      this.saidCount = -1;
      clearTimeout(this.sayTimer);
      this.live.textContent = '';
    }

    // -------------------------------------------------------- Advisor check
    async runCheck() {
      const ta = this.ta;
      const token = ta.form?.elements.namedItem('__csrf')?.value || document.querySelector('input[name=__csrf]')?.value || '';
      const body = new URLSearchParams({ __csrf: token, sql: ta.value, shape: ta.dataset.codeCheck || 'select', ...scope() });
      this.msg.className = 'ce-msg';
      this.msg.textContent = 'Checking…';
      try {
        const r = await fetch('/builder/code/check', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
        const d = r.ok ? await r.json() : { ok: false, severity: 'error', message: `The check failed (${r.status}).` };
        this.msg.classList.add(d.ok ? (d.severity === 'info' || d.severity === 'warning' ? 'ce-msg-warn' : 'ce-msg-ok') : 'ce-msg-error');
        this.msg.textContent = d.message;
      } catch {
        this.msg.classList.add('ce-msg-error');
        this.msg.textContent = 'The check failed.';
      }
    }
  }

  /** First index with arr[i] >= value (arr ascending). */
  function lowerBound(arr, value) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const editors = new WeakMap();
  function enhance(root) {
    for (const ta of (root || document).querySelectorAll('textarea[data-code]')) {
      if (editors.has(ta) || ta.closest('.ce')) continue;
      editors.set(ta, new Editor(ta));
    }
  }
  window.pgapexCodeEditor = { enhance, editorOf: (ta) => editors.get(ta) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhance());
  else enhance();
  document.addEventListener('pgapex:replaced', (e) => enhance(e.detail && e.detail.parentElement ? e.detail.parentElement : document));
  // keep the caret position and bracket match current
  document.addEventListener('selectionchange', () => {
    const ta = document.activeElement;
    const ed = ta && ta.tagName === 'TEXTAREA' && editors.get(ta);
    if (ed) ed.caretMoved();
  });
})();
