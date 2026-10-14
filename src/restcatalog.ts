import { owner } from './db.ts';
import { sourceProblems, type RestColumn, type RestParam } from './websources.ts';

// REST source catalogs (migration 095; APEX: Workspace Utilities → REST Source
// Catalogs): a workspace's descriptions of web services. A catalog has a base
// URL and services (endpoints); an application makes a REST data source from a
// service (a copy: meta.rest_source). Catalogs are entered by hand, read from an
// OpenAPI 3 or Swagger 2 document (JSON), or imported from a catalog file
// (format "pgkiln-rest-catalog/1") that another workspace exported.
//
// The OpenAPI reader takes what a REST data source can use: per operation the
// path and its parameters (path, query, header; the scalar properties of a JSON
// request body), and from the JSON response of 200/201 (or default) where the
// rows are and their columns. A collection with an item path (GET /pets and
// PUT/DELETE /pets/{petId}) gets key columns and write-back operations. What it
// can't use is listed in the notes, never silently dropped.

export interface CatalogService {
  name: string;
  description: string | null;
  path: string;
  method: string;
  params: RestParam[];
  headers: Record<string, string>;
  body: string | null;
  row_selector: string | null;
  columns: RestColumn[];
  key_columns: string[];
  operations: Record<string, Record<string, string>>;
}

export interface Catalog {
  name: string;
  description: string | null;
  base_url: string;
  source: 'manual' | 'openapi';
  api_version: string | null;
  services: CatalogService[];
}

export const CATALOG_FORMAT = 'pgkiln-rest-catalog/1';
const CATALOG_NAME = /^\S(.{0,58}\S)?$/;
const SERVICE_NAME = /^[A-Z][A-Z0-9_]{0,59}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_SERVICES = 500;
const MAX_COLUMNS = 200;
const MAX_PARAMS = 50;
const ROW_PROPERTIES = ['items', 'data', 'results', 'records', 'rows', 'content', 'value', 'values', 'list', 'entries', 'elements', 'objects'];

/** "https://api.example.com/v1/" → "https://api.example.com/v1" */
export const trimBase = (url: string) => url.trim().replace(/\/+$/, '');

/** A service's full URL: the catalog's base URL and the service's path. */
export const serviceUrl = (baseUrl: string, path: string) => `${trimBase(baseUrl)}${path}`;

/** Problems with a catalog's own fields (empty: fine). */
export function catalogProblems(c: { name?: unknown; base_url?: unknown; description?: unknown; api_version?: unknown }): string[] {
  const out: string[] = [];
  if (typeof c.name !== 'string' || !CATALOG_NAME.test(c.name)) out.push('The name is 1 to 60 characters, without spaces at the start or end.');
  if (typeof c.base_url !== 'string' || !/^https?:\/\/[^\s<>"{}]+$/i.test(c.base_url) || c.base_url.length > 2000) out.push('The base URL starts with http:// or https://, without spaces or {parameters}, e.g. https://api.example.com/v1.');
  else if (c.base_url.endsWith('/')) out.push('The base URL ends without a slash: the services\' paths start with one.');
  else {
    try {
      const u = new URL(c.base_url);
      if (u.username || u.password) out.push('The base URL may not contain a user name or password: an application\'s web credential signs in.');
      if (u.search || u.hash) out.push('The base URL has no query or fragment: they belong to a service\'s path.');
    } catch {
      out.push('The base URL is not valid.');
    }
  }
  if (c.description != null && (typeof c.description !== 'string' || c.description.length > 2000)) out.push('The description is at most 2000 characters.');
  if (c.api_version != null && (typeof c.api_version !== 'string' || c.api_version.length > 100)) out.push('The API version is at most 100 characters.');
  return out;
}

/** Problems with a service (as a REST data source on the catalog's base URL; empty: fine). */
export function serviceProblems(baseUrl: string, v: Partial<CatalogService>): string[] {
  const at = `Service ${typeof v.name === 'string' ? v.name : '?'}:`;
  const out: string[] = [];
  if (typeof v.name !== 'string' || !SERVICE_NAME.test(v.name)) out.push(`${at} the name is upper case letters, digits and _, starting with a letter (at most 60), e.g. GET_PETS.`);
  if (typeof v.path !== 'string' || !/^\/[^\s<>"]*$/.test(v.path) || v.path.length > 2000) out.push(`${at} the path starts with /, without spaces, e.g. /pets/{pet_id}.`);
  if (!METHODS.includes(String(v.method))) out.push(`${at} the method is one of ${METHODS.join(', ')}.`);
  if (v.description != null && (typeof v.description !== 'string' || v.description.length > 2000)) out.push(`${at} the description is at most 2000 characters.`);
  if (typeof v.path === 'string' && /^\/[^\s<>"]*$/.test(v.path))
    for (const p of sourceProblems({ url: serviceUrl(baseUrl, v.path), params: v.params ?? [], columns: v.columns ?? [], headers: v.headers ?? {}, row_selector: v.row_selector, key_columns: v.key_columns ?? [], operations: v.operations ?? {} }))
      out.push(`${at} ${p}`);
  return out;
}

/** Every problem of a whole catalog (its fields, each service, duplicate names). */
export function wholeCatalogProblems(c: Catalog): string[] {
  const out = catalogProblems(c);
  if (!Array.isArray(c.services)) return [...out, 'The services are a list.'];
  if (c.services.length > MAX_SERVICES) out.push(`A catalog has at most ${MAX_SERVICES} services.`);
  const seen = new Set<string>();
  for (const s of c.services) {
    if (seen.has(s.name)) out.push(`Service ${s.name} is there twice.`);
    seen.add(s.name);
    // (enough to fix the first ones: a big broken document would list thousands)
    if (out.length < 50) out.push(...serviceProblems(typeof c.base_url === 'string' ? c.base_url : 'https://x', s));
  }
  return out;
}

// ---------------------------------------------------------------- names

/** petId → pet_id, X-Request-ID → x_request_id: a valid parameter or column name. */
export function snake(s: string) {
  let n = s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!n) n = 'x';
  if (/^\d/.test(n)) n = `_${n}`;
  return n.slice(0, 63);
}

/** listPets → LIST_PETS; a service name (upper case, starts with a letter, at most 60). */
export function serviceName(s: string) {
  let n = snake(s).toUpperCase().replace(/^_+/, '');
  if (!/^[A-Z]/.test(n)) n = `S_${n}`;
  return n.slice(0, 60).replace(/_+$/, '') || 'SERVICE';
}

function unique(name: string, taken: Set<string>, max: number) {
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${name.slice(0, max - String(i).length - 1)}_${i}`;
  taken.add(n);
  return n;
}

// ---------------------------------------------------------------- OpenAPI

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

class Reader {
  readonly notes: string[] = [];
  constructor(readonly doc: Json) {}

  note(n: string) {
    if (this.notes.length < 200 && !this.notes.includes(n)) this.notes.push(n);
  }

  /** Follow local $refs (#/components/…, #/definitions/…); external ones are noted and dropped. */
  deref(v: unknown, depth = 0): Json | null {
    if (!isObj(v)) return null;
    if (typeof v.$ref !== 'string') return v;
    if (depth > 30) {
      this.note(`A $ref chain is too deep (or circular): ${v.$ref}.`);
      return null;
    }
    if (!v.$ref.startsWith('#/')) {
      this.note(`External references are not read: ${v.$ref}.`);
      return null;
    }
    let cur: unknown = this.doc;
    for (const part of v.$ref.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      cur = isObj(cur) || Array.isArray(cur) ? (cur as Json)[key] : undefined;
    }
    if (cur === undefined) {
      this.note(`A $ref points nowhere: ${v.$ref}.`);
      return null;
    }
    return this.deref(cur, depth + 1);
  }

  /** A schema with allOf merged (properties and required), for reading properties. */
  schema(v: unknown, depth = 0): Json | null {
    const s = this.deref(v);
    if (!s || depth > 10) return s;
    if (Array.isArray(s.allOf)) {
      const merged: Json = { ...s, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
      delete merged.allOf;
      for (const part of s.allOf) {
        const p = this.schema(part, depth + 1);
        if (!p) continue;
        Object.assign(merged.properties, p.properties ?? {});
        merged.required.push(...(Array.isArray(p.required) ? p.required : []));
        if (!merged.type && p.type) merged.type = p.type;
        if (!merged.items && p.items) merged.items = p.items;
      }
      return merged;
    }
    // oneOf / anyOf: the first alternative is a fair guess for the columns
    for (const k of ['oneOf', 'anyOf'])
      if (Array.isArray(s[k]) && s[k].length && !s.properties && !s.items) return this.schema(s[k][0], depth + 1);
    return s;
  }

  typeOf(s: Json | null): string | undefined {
    if (!s) return undefined;
    const t = Array.isArray(s.type) ? s.type.find((x: unknown) => x !== 'null') : s.type;
    if (t) return t;
    if (s.properties) return 'object';
    if (s.items) return 'array';
    return undefined;
  }

  columnType(prop: unknown): RestColumn['type'] {
    const s = this.schema(prop);
    const t = this.typeOf(s);
    if (t === 'integer') return 'integer';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'string') return s?.format === 'date' ? 'date' : s?.format === 'date-time' ? 'timestamp' : 'text';
    if (t === 'object' || t === 'array') return 'json';
    return 'text';
  }

  /** The columns of a row schema: its properties, in order (at most MAX_COLUMNS). */
  columns(row: Json | null): RestColumn[] {
    const props = isObj(row?.properties) ? Object.entries(row!.properties as Json) : [];
    const taken = new Set<string>();
    const out: RestColumn[] = [];
    for (const [k, v] of props) {
      if (out.length >= MAX_COLUMNS) {
        this.note(`Only the first ${MAX_COLUMNS} properties became columns.`);
        break;
      }
      const name = unique(snake(k), taken, 63);
      out.push({ name, path: /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `$[${JSON.stringify(k)}]`, type: this.columnType(v) });
    }
    return out;
  }

  /** Where the rows are in a response schema, and the schema of one row. */
  rows(schema: unknown): { row_selector: string | null; row: Json | null } {
    const s = this.schema(schema);
    if (!s) return { row_selector: null, row: null };
    if (this.typeOf(s) === 'array') return { row_selector: null, row: this.schema(s.items) };
    const props = isObj(s.properties) ? (s.properties as Json) : {};
    const arrays = Object.keys(props).filter((k) => {
      const p = this.schema(props[k]);
      return this.typeOf(p) === 'array' && this.typeOf(this.schema(p?.items)) === 'object';
    });
    const pick = arrays.find((k) => ROW_PROPERTIES.includes(k.toLowerCase())) ?? (arrays.length === 1 ? arrays[0] : undefined);
    if (pick) return { row_selector: /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pick) ? pick : `$[${JSON.stringify(pick)}]`, row: this.schema(this.schema(props[pick])?.items) };
    return { row_selector: null, row: s };
  }

  /** The JSON schema of an operation's success response (OpenAPI 3: content; Swagger 2: schema). */
  responseSchema(op: Json): unknown {
    const responses = isObj(op.responses) ? op.responses : {};
    const code = ['200', '201', '2XX', '2xx', 'default'].find((c) => responses[c] !== undefined) ?? Object.keys(responses).find((c) => /^2\d\d$/.test(c));
    if (!code) return undefined;
    const r = this.deref(responses[code]);
    if (!r) return undefined;
    if (r.schema) return r.schema;
    return jsonContent(r.content)?.schema;
  }
}

// The JSON media type of a content map (application/json, application/problem+json, or */* as a last resort).
function jsonContent(content: unknown): Json | null {
  if (!isObj(content)) return null;
  const key = Object.keys(content).find((k) => /^application\/(?:[\w.+-]*\+)?json\b/i.test(k)) ?? Object.keys(content).find((k) => k === '*/*');
  return key && isObj(content[key]) ? content[key] : null;
}

const scalar = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

/** The base URL of an OpenAPI 3 or Swagger 2 document (relative ones against `from`). */
function documentBase(doc: Json, from: string | undefined, notes: string[]): string | null {
  let url: string | null = null;
  if (Array.isArray(doc.servers) && isObj(doc.servers[0]) && typeof doc.servers[0].url === 'string') {
    const server = doc.servers[0];
    url = server.url.replace(/\{([^}]+)\}/g, (m: string, name: string) => {
      const v = isObj(server.variables?.[name]) ? scalar(server.variables[name].default) : undefined;
      if (v === undefined) notes.push(`The server variable {${name}} has no default: enter the base URL.`);
      return v ?? m;
    });
    if (doc.servers.length > 1) notes.push(`The document lists ${doc.servers.length} servers: the first one is the base URL (${server.url}).`);
  } else if (typeof doc.host === 'string') {
    const scheme = Array.isArray(doc.schemes) ? (doc.schemes.includes('https') ? 'https' : doc.schemes[0]) : 'https';
    url = `${scheme}://${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`;
  } else if (typeof doc.basePath === 'string') url = doc.basePath;
  if (url && /\{/.test(url)) return null;
  if (url && !/^https?:\/\//i.test(url)) {
    if (!from) return null;
    try {
      url = new URL(url, from).href;
    } catch {
      return null;
    }
  }
  return url ? trimBase(url) : from ? trimBase(new URL(from).origin) : null;
}

/**
 * A catalog from an OpenAPI 3.x or Swagger 2.0 document (parsed JSON).
 * `baseUrl` overrides the document's server; `from` is where the document was
 * read from (a relative server URL is resolved against it).
 */
export function fromOpenApi(doc: unknown, opts: { baseUrl?: string; from?: string; name?: string } = {}): { catalog: Catalog; notes: string[] } {
  if (!isObj(doc) || !(typeof doc.openapi === 'string' || doc.swagger === '2.0')) throw new Error('This is not an OpenAPI 3 or Swagger 2.0 document (no "openapi" or "swagger" field).');
  if (typeof doc.openapi === 'string' && !/^3\./.test(doc.openapi)) throw new Error(`OpenAPI ${doc.openapi} is not supported: version 3.x or Swagger 2.0.`);
  const r = new Reader(doc);
  const baseNotes: string[] = [];
  const base = opts.baseUrl?.trim() ? trimBase(opts.baseUrl) : documentBase(doc, opts.from, baseNotes);
  for (const n of baseNotes) r.note(n);
  if (!base) throw new Error('The document has no absolute server URL: enter the base URL of the service.');
  const info = isObj(doc.info) ? doc.info : {};
  const taken = new Set<string>();
  const services: CatalogService[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  const swagger2 = doc.swagger === '2.0';

  for (const [rawPath, item0] of Object.entries(paths)) {
    const item = r.deref(item0);
    if (!item || !rawPath.startsWith('/')) continue;
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      const op = r.deref(item[m]);
      if (!op) continue;
      if (!METHODS.includes(m.toUpperCase())) {
        r.note(`${m.toUpperCase()} ${rawPath}: only GET, POST, PUT, PATCH and DELETE become services.`);
        continue;
      }
      if (services.length >= MAX_SERVICES) {
        r.note(`Only the first ${MAX_SERVICES} operations became services.`);
        break;
      }
      const where = `${m.toUpperCase()} ${rawPath}`;
      // parameters: the path's, overridden by the operation's (by name and location)
      const byKey = new Map<string, Json>();
      for (const p0 of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = r.deref(p0);
        if (p && typeof p.name === 'string' && typeof p.in === 'string') byKey.set(`${p.in}:${p.name}`, p);
      }
      const params: RestParam[] = [];
      const names = new Set<string>();
      let path = rawPath;
      let body: Json | null = null;
      for (const p of byKey.values()) {
        if (params.length >= MAX_PARAMS) {
          r.note(`${where}: only the first ${MAX_PARAMS} parameters were kept.`);
          break;
        }
        if (p.in === 'body') {
          body = r.schema(p.schema);
          continue;
        }
        if (!['path', 'query', 'header'].includes(p.in)) {
          r.note(`${where}: ${p.in} parameter ${p.name} is not supported (path, query, header and a JSON body are).`);
          continue;
        }
        if (p.in === 'header' && ['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'accept', 'content-type'].includes(p.name.toLowerCase())) {
          if (['authorization', 'proxy-authorization', 'cookie'].includes(p.name.toLowerCase())) r.note(`${where}: the ${p.name} header is left out: an application's web credential signs in.`);
          continue;
        }
        const name = unique(snake(p.name), names, 63);
        const param: RestParam = { name, in: p.in };
        const sch = r.schema(p.schema) ?? p;
        const def = scalar(sch.default) ?? scalar(p.example) ?? (Array.isArray(sch.enum) && p.required ? scalar(sch.enum[0]) : undefined);
        if (def !== undefined) param.default = def;
        if (p.required || p.in === 'path') param.required = true;
        if (p.in === 'path') path = path.split(`{${p.name}}`).join(`{${name}}`);
        else if (name !== p.name) param.key = p.name;
        params.push(param);
      }
      // a path parameter the document forgot to declare
      for (const mm of path.matchAll(/\{([^}]+)\}/g))
        if (!params.some((p) => p.in === 'path' && p.name === mm[1])) {
          const name = unique(snake(mm[1]), names, 63);
          path = path.split(`{${mm[1]}}`).join(`{${name}}`);
          params.push({ name, in: 'path', required: true });
        }
      // a JSON request body: its scalar properties become body parameters
      if (!swagger2 && op.requestBody) {
        const rb = r.deref(op.requestBody);
        const content = rb ? jsonContent(rb.content) : null;
        if (rb && !content) r.note(`${where}: a request body that isn't JSON is not supported.`);
        body = content ? r.schema(content.schema) : body;
      }
      if (body) {
        const req: string[] = Array.isArray(body.required) ? body.required : [];
        const props = isObj(body.properties) ? Object.entries(body.properties as Json) : [];
        let skipped = 0;
        for (const [k, v] of props) {
          const t = r.columnType(v);
          if (t === 'json' || params.length >= MAX_PARAMS) {
            skipped++;
            continue;
          }
          const name = unique(snake(k), names, 63);
          const param: RestParam = { name, in: 'body' };
          if (name !== k) param.key = k;
          if (req.includes(k)) param.required = true;
          params.push(param);
        }
        if (skipped) r.note(`${where}: ${skipped} nested request body propert${skipped > 1 ? 'ies were' : 'y was'} left out (write a body template for them).`);
        if (!props.length && r.typeOf(body) === 'array') r.note(`${where}: the request body is a list: write a body template.`);
      }
      const { row_selector, row } = r.rows(r.responseSchema(op));
      const columns = r.columns(row);
      if (m === 'get' && !columns.length) r.note(`${where}: no JSON response schema with properties, so no columns: use "Test" on the data source to get them.`);
      const id = typeof op.operationId === 'string' && op.operationId.trim() ? op.operationId : `${m}_${rawPath.replace(/\{([^}]+)\}/g, 'by_$1')}`;
      const description = [op.summary, op.description].find((d) => typeof d === 'string' && d.trim());
      services.push({
        name: unique(serviceName(id), taken, 60),
        description: description ? String(description).trim().slice(0, 2000) : null,
        path,
        method: m.toUpperCase(),
        params,
        headers: {},
        body: null,
        row_selector,
        columns,
        key_columns: [],
        operations: {},
      });
    }
  }
  if (!services.length) r.note('The document has no operations that can become services.');
  linkOperations(services);
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'REST service';
  const name = (opts.name?.trim() || title).slice(0, 60).trim();
  return {
    catalog: {
      name,
      description: typeof info.description === 'string' ? info.description.trim().slice(0, 2000) || null : null,
      base_url: base,
      source: 'openapi',
      api_version: typeof info.version === 'string' || typeof info.version === 'number' ? String(info.version).slice(0, 100) : null,
      services,
    },
    notes: r.notes,
  };
}

/**
 * A collection GET (/pets) whose item path (/pets/{pet_id}) has GET, PUT/PATCH or
 * DELETE, and the collection a POST: key columns and write-back operations, when
 * the item's parameter names a column (pet_id, or else id).
 */
function linkOperations(services: CatalogService[]) {
  for (const list of services) {
    if (list.method !== 'GET' || !list.columns.length || /\{[^}]+\}$/.test(list.path) || list.path.includes('?')) continue;
    const item = new RegExp(`^${list.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '\\{[^}]+\\}')}/\\{([^}]+)\\}$`);
    const cols = list.columns.map((c) => c.name);
    const ops: Record<string, Record<string, string>> = {};
    let key: string | null = null;
    for (const s of services) {
      const m = item.exec(s.path);
      if (!m) continue;
      const col = cols.includes(m[1]) ? m[1] : cols.includes('id') ? 'id' : null;
      if (!col || (key && key !== col)) continue;
      const op = s.method === 'GET' ? 'fetch' : s.method === 'DELETE' ? 'delete' : s.method === 'PUT' || s.method === 'PATCH' ? 'update' : null;
      if (!op || (op === 'update' && ops.update?.method === 'PUT')) continue;
      key = col;
      ops[op] = { method: s.method, path: `/{${col}}` };
    }
    if (!key) continue;
    if (services.some((s) => s.method === 'POST' && s.path === list.path)) ops.insert = { method: 'POST' };
    list.key_columns = [key];
    list.operations = ops;
  }
}

// ---------------------------------------------------------------- catalog files

/** A catalog as a file (another workspace or installation imports it). */
export function catalogDocument(c: Catalog) {
  return {
    format: CATALOG_FORMAT,
    name: c.name,
    description: c.description,
    base_url: c.base_url,
    source: c.source,
    api_version: c.api_version,
    services: c.services.map((s) => ({
      name: s.name, description: s.description, path: s.path, method: s.method, params: s.params, headers: s.headers,
      body: s.body, row_selector: s.row_selector, columns: s.columns, key_columns: s.key_columns, operations: s.operations,
    })),
  };
}

/** A catalog file's catalog (checked by the caller with wholeCatalogProblems). */
export function fromCatalogDocument(doc: Json): Catalog {
  if (doc.format !== CATALOG_FORMAT) throw new Error(`Not a REST source catalog file (format ${CATALOG_FORMAT}).`);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    name: String(doc.name ?? ''),
    description: str(doc.description),
    base_url: String(doc.base_url ?? ''),
    source: doc.source === 'openapi' ? 'openapi' : 'manual',
    api_version: str(doc.api_version),
    services: (Array.isArray(doc.services) ? doc.services : []).map((s: Json) => ({
      name: String(s?.name ?? ''),
      description: str(s?.description),
      path: String(s?.path ?? ''),
      method: String(s?.method ?? 'GET').toUpperCase(),
      params: s?.params ?? [],
      headers: s?.headers ?? {},
      body: str(s?.body),
      row_selector: str(s?.row_selector),
      columns: s?.columns ?? [],
      key_columns: s?.key_columns ?? [],
      operations: s?.operations ?? {},
    })),
  };
}

/** A file's text as a catalog: a pgkiln catalog file, or an OpenAPI / Swagger document (JSON). */
export function readCatalogText(text: string, opts: { baseUrl?: string; from?: string; name?: string } = {}): { catalog: Catalog; notes: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(/^\s*(openapi|swagger)\s*:/m.test(text)
      ? 'This looks like an OpenAPI document in YAML: pgkiln reads JSON. Most services offer their document as JSON too (e.g. openapi.json), or convert it with any YAML tool.'
      : 'The file is not valid JSON.');
  }
  if (isObj(doc) && doc.format === CATALOG_FORMAT) {
    const catalog = fromCatalogDocument(doc);
    if (opts.name?.trim()) catalog.name = opts.name.trim().slice(0, 60);
    if (opts.baseUrl?.trim()) catalog.base_url = trimBase(opts.baseUrl);
    return { catalog, notes: [] };
  }
  return fromOpenApi(doc, opts);
}

// ---------------------------------------------------------------- storage

export interface StoredService extends CatalogService {
  id: number;
  position: number;
}

export interface StoredCatalog extends Omit<Catalog, 'services'> {
  id: number;
  workspace_id: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  services: StoredService[];
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** A catalog with its services, or null. */
export async function loadCatalog(id: number | string, db: Q = owner): Promise<StoredCatalog | null> {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const c = (await db.query('select * from meta.rest_catalog where id = $1', [id])).rows[0];
  if (!c) return null;
  c.services = (await db.query('select * from meta.rest_catalog_service where catalog_id = $1 order by position, name', [id])).rows;
  return c;
}

/** Insert a checked catalog into a workspace (inside the caller's transaction); its id. */
export async function insertCatalog(db: Q, workspaceId: number, c: Catalog, by: string | null): Promise<number> {
  const { id } = (await db.query(
    `insert into meta.rest_catalog (workspace_id, name, description, base_url, source, api_version, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [workspaceId, c.name, c.description, c.base_url, c.source, c.api_version, by],
  )).rows[0];
  await insertServices(db, id, c.services);
  return id;
}

/** Replace a catalog's fields and services (inside the caller's transaction). */
export async function replaceCatalog(db: Q, id: number, c: Catalog) {
  await db.query(
    `update meta.rest_catalog set name = $2, description = $3, base_url = $4, source = $5, api_version = $6, updated_at = now() where id = $1`,
    [id, c.name, c.description, c.base_url, c.source, c.api_version],
  );
  await db.query('delete from meta.rest_catalog_service where catalog_id = $1', [id]);
  await insertServices(db, id, c.services);
}

async function insertServices(db: Q, catalogId: number, services: CatalogService[]) {
  let pos = 0;
  for (const s of services)
    await db.query(
      `insert into meta.rest_catalog_service (catalog_id, name, description, path, method, params, headers, body, row_selector, columns, key_columns, operations, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [catalogId, s.name, s.description, s.path, s.method, JSON.stringify(s.params), JSON.stringify(s.headers ?? {}), s.body, s.row_selector,
        JSON.stringify(s.columns), s.key_columns ?? [], JSON.stringify(s.operations ?? {}), (pos += 10)],
    );
}

/**
 * The values of a REST data source made from a catalog service (meta.rest_source
 * columns): the full URL and a copy of the request and response settings.
 */
export function sourceFromService(c: { base_url: string; name: string }, s: CatalogService, opts: { name?: string; credential?: string | null } = {}) {
  return {
    name: (opts.name?.trim() || s.name).toUpperCase(),
    description: s.description ?? `From the REST source catalog ${c.name}.`,
    url: serviceUrl(c.base_url, s.path),
    method: s.method,
    credential: opts.credential?.trim() ? opts.credential.trim().toUpperCase() : null,
    params: s.params,
    headers: s.headers ?? {},
    body: s.body,
    row_selector: s.row_selector,
    columns: s.columns,
    key_columns: s.key_columns ?? [],
    operations: s.operations ?? {},
  };
}
