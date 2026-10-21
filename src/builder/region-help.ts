// The help of a region's Attributes (JSON) in the Page Designer, per region type (sprint 51):
// an existing region sees only the keys of its own type and a link to its section of the guide;
// a new region (type not chosen yet) sees all of them. Each entry: the types it applies to
// ("*": every type) and the text.

/** The user guide on the website (chapter 4 and, for tasks and workflows, chapter 6). */
const GUIDE = 'https://pgkiln.vargar.eu/docs';

export const REGION_CONFIG_HELP: [string[], string][] = [
  [['report'], '{"page_size":15,"pagination":"range" (rows X–Y without a total),"keyset":["id"] (with range: Next/Previous seek on these unique columns),"max_rows":10000,"searchable":true,"sortable":true,"interactive":true,"mobile":"reflow"|"scroll","hidden":["col"],"headings":{"col":"Label"},"link":{"column":"id","page":3,"items":{"P3_ID":"#id#"}},"empty":"No rows","pdf":{"layout":"NAME","columns":["col"],"widths":{"col":40},"align":{"col":"right"}}} (pdf widths in mm; layouts under Shared Components → Report layouts)'],
  [['report', 'grid', 'cards'], '{"formats":{"sal":"FML999G990D00","hiredate":"DD-MON-YYYY"}} (number or date format masks per column)'],
  [['chart'], '{"kind":"bar"|"column"|"line"|"area"|"donut","max_rows":1000,"format_mask":"FML999G990"}'],
  [['cards'], '{"style":"metric","link":{...},"max_rows":500}'],
  [['dynamic'], '{"max_rows":1000}'],
  [['grid'], '{"page_size":25,"allow":{"insert":true,"update":true,"delete":true},"readonly":["col"],"columns":{"deptno":{"lov":"LOV:DEPARTMENTS","required":true}},"aggregates":{"sal":["sum","avg"]},"layout":{"order":["col"],"hidden":["col"],"widths":{"col":160},"frozen":1},"row_actions":{"edit":{"page":3,"items":{"P3_ID":"#id#"}},"duplicate":true,"delete":true,"links":[{"label":"…","page":4,"items":{}}]},"select_row":{"column":"id","item":"P1_ID"} (a master),"master":{"item":"P1_ID","column":"parent_id"} (a detail; any region type),"actions":true,"saved_reports":true,"public_reports":"SCHEME","views":["row","group","chart"] (views besides the grid; left out: all three)}'],
  [['calendar'], '{"link":{...}}'],
  [['facets'], '{"report":<region id>,"search":true,"facets":[{"column":"job","label":"Job","exclude":true},{"column":"sal","type":"range","ranges":[{"to":1000},{"from":1000}],"custom":true},{"column":"rating","type":"star","max":5}]}'],
  [['smart_filters'], '{"report":<region id>,"suggestions":3,"placeholder":"…","ask":true,"facets":[…as facets]}'],
  [['display_selector'], '{"style":"tabs"|"select","show_all":true,"remember":true}'],
  [['list'], '{"list":"NAME","template":"links"|"badges"|"cards"|"tabs"} (lists under Shared Components → Lists)'],
  [['*'], '{"display_selector":true} puts it in the page\'s display selector'],
  [['report', 'chart', 'cards', 'dynamic', 'tree', 'template_component'], '{"lazy":true} loads it after the page shows, {"cache":{"scope":"user"|"session"|"all","seconds":300}} keeps its HTML (a submit of the page empties it)'],
  [['data_reporter'], '{"sources":[{"id":"orders","label":"Orders","description":"…","schema":"sales","table":"order_v","columns":[{"name":"total","label":"Total","format":"FML999G990D00"}]}],"sharing":true,"share_authz":"SCHEME","page_size":25} (the Data Reporter settings below edit it)'],
  [['form_designer'], '{"sources":[{"id":"orders","label":"Orders","description":"…","schema":"sales","table":"orders","key":"id","columns":[{"name":"customer","label":"Customer"},{"name":"status","lov":"LOV:ORDER_STATUS"}],"insert":true,"update":true,"delete":false}],"design_authz":"SCHEME","page_size":25} (the Form Designer region\'s Settings; users that pass design_authz design forms)'],
  [['ai_assistant'], '{"service":"NAME","system":"…","welcome":"…","context":[{"name":"policy","sql":"select … :AI_PROMPT …"}],"tools":[{"name":"my_leave","description":"…","sql":"select … where status = :STATUS","parameters":{"STATUS":{"type":"string","enum":["PENDING"]}}},{"name":"dept","type":"rest","source":"DEPARTMENT","description":"…"}],"max_rounds":5,"max_turns":20}; or {"agent":"SALES_AGENT","welcome":"…"} for an AI agent of Shared Components (the AI assistant settings below edit it)'],
  [['report'], '{"ai_filter":{}} adds an "Ask in your own words" box: the question becomes the report\'s settings, shown as chips (built-in phrases; {"service":"NAME"} uses an AI service)'],
  [['plugin'], '{"plugin":"name","attributes":{"NAME":"value"}} (a region plug-in; a Source SELECT feeds its template)'],
  [['form'], '{"lost_update":false} saves without checking that the row is unchanged since it was shown'],
  [['login'], '(no attributes) the sign-in form of the application\'s login page (Application settings → Login page): providers, user name and password, "Keep me signed in", "Forgot password?"'],
  [['url'], '{"height":480,"sandbox":["allow-scripts","allow-forms","allow-popups","allow-same-origin"] (the default; false: no sandbox),"fullscreen":true}'],
  [['search'], '{"configs":["CUSTOMERS","ORDERS"] (Shared Components → Search configurations; empty: all),"item":"P1_SEARCH" (search with this item\'s value instead of a field of its own),"placeholder":"…","min_length":2,"empty":"No results"}'],
];

/** Where each region type is described in the guide. */
const ANCHORS: Record<string, string> = {
  report: 'report-interactive-report',
  grid: 'grid-interactive-grid',
  form: 'form',
  chart: 'chart',
  cards: 'cards',
  calendar: 'calendar',
  facets: 'facets-faceted-search',
  smart_filters: 'smart-filters',
  display_selector: 'display-selector-region-display-selector',
  map: 'map',
  tree: 'tree',
  list: 'list-lists',
  data_reporter: 'data-reporter-data-reporter',
  form_designer: 'form_designer-form-designer',
  ai_assistant: 'ai-assistant-ai-assistant',
  template_component: 'template-components',
  static: 'static-and-dynamic-content',
  dynamic: 'static-and-dynamic-content',
  url: 'url-url-region',
  search: 'search-search-region',
  plugin: 'plug-ins-with-their-own-code',
  tasks: 'approvals-and-the-task-list',
  workflows: 'workflows',
  login: 'the-login-page',
};

/** The help of every type (a region whose type isn't known yet). */
export const ALL_REGION_CONFIG_HELP = REGION_CONFIG_HELP.map(([types, text]) => `${types.includes('*') ? 'any region' : types.join(', ')}: ${text}`).join(' · ');

/** The keys of one region type, and where the guide describes it. */
export function regionConfigHelp(type: string | null | undefined): { text: string; url: string | null } {
  if (!type) return { text: ALL_REGION_CONFIG_HELP, url: null };
  const own = REGION_CONFIG_HELP.filter(([types]) => types.includes(type)).map(([, text]) => text);
  const any = REGION_CONFIG_HELP.filter(([types]) => types.includes('*')).map(([, text]) => `any region: ${text}`);
  const chapter = type === 'tasks' || type === 'workflows' ? 'processing' : type === 'login' ? 'security' : 'pages-and-regions';
  return {
    text: [...own, ...any].join(' · ') || 'No attributes of its own.',
    url: ANCHORS[type] ? `${GUIDE}/${chapter}#${ANCHORS[type]}` : null,
  };
}
