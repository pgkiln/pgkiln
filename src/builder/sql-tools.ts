// (sprint 96, Database Actions DA-15) The SQL Workshop's tools in one list: the home page's Launchpad tabs
// (Development, Administration, Monitoring), the More menu's headings and the builder's search (Ctrl+K) read it.
// `tab` is the SQL Workshop tab a tool's own pages mark (workshopTabs in ui.ts); tools without one are pages
// elsewhere in the builder.

export type ToolGroup = 'development' | 'administration' | 'monitoring';
export interface SqlTool {
  key: string;
  href: string;
  icon: string;
  label: string;
  description: string;
  group: ToolGroup;
  /** the SQL Workshop tab its pages mark */
  tab?: string;
  /** one of the main tabs (not in More) */
  main?: boolean;
  /** administrators only */
  admin?: boolean;
}

export const TOOL_GROUPS: [ToolGroup, string][] = [['development', 'Development'], ['administration', 'Administration'], ['monitoring', 'Monitoring']];

export const SQL_TOOLS: SqlTool[] = [
  { key: 'worksheet', href: '/builder/sql/worksheet', icon: 'code', label: 'SQL Worksheet', description: 'Run statements and scripts with a navigator, plans, results and history.', group: 'development', tab: 'sql', main: true },
  { key: 'objects', href: '/builder/sql/objects', icon: 'database', label: 'Object Browser', description: 'Tables, views and functions with their columns, data, keys, policies and DDL.', group: 'development', tab: 'objects', main: true },
  { key: 'scripts', href: '/builder/sql/scripts', icon: 'file', label: 'SQL Scripts', description: 'Saved scripts of the workspace: upload, run, download, run history.', group: 'development', tab: 'scripts', main: true },
  { key: 'table', href: '/builder/sql/objects/table', icon: 'table', label: 'Create Table', description: 'A new table in a form: columns, keys, indexes and security.', group: 'development' },
  { key: 'charts', href: '/builder/sql/charts', icon: 'chart', label: 'Charts', description: 'Queries drawn as charts, and a dashboard of them.', group: 'development', tab: 'charts' },
  { key: 'quicksql', href: '/builder/sql/quick', icon: 'bolt', label: 'Quick SQL', description: 'A data model in shorthand, turned into DDL.', group: 'development', tab: 'quicksql' },
  { key: 'query', href: '/builder/sql/query', icon: 'filter', label: 'Query Builder', description: 'A query from tables and their joins, drawn.', group: 'development', tab: 'query' },
  { key: 'load', href: '/builder/sql/load', icon: 'upload', label: 'Load Data', description: 'CSV, Excel, JSON or XML into a new or existing table.', group: 'development', tab: 'load' },
  { key: 'unload', href: '/builder/sql/unload', icon: 'download', label: 'Unload Data', description: 'A table, view or query as CSV, JSON, Excel, XML or SQL inserts.', group: 'development', tab: 'unload' },
  { key: 'sample', href: '/builder/sql/sample-data', icon: 'layers', label: 'Sample Data', description: 'Rows that look real, for development.', group: 'development', tab: 'sample' },
  { key: 'ddl', href: '/builder/sql/ddl', icon: 'file', label: 'Generate DDL', description: 'A schema\'s objects as one script.', group: 'development', tab: 'ddl' },
  { key: 'compare', href: '/builder/sql/compare', icon: 'layers', label: 'Schema Comparison', description: 'The differences between two schemas, and the SQL to align them.', group: 'development', tab: 'compare' },
  { key: 'modeler', href: '/builder/sql/modeler', icon: 'org', label: 'Data Modeler', description: 'Relational diagrams of tables and their foreign keys; DDL and a data dictionary from them.', group: 'development', tab: 'modeler' },
  { key: 'rest', href: '/builder/sql/rest', icon: 'globe', label: 'RESTful Services', description: 'Tables and views as REST endpoints (AutoREST): URLs, examples, OpenAPI.', group: 'development', tab: 'rest' },
  { key: 'ai', href: '/builder/sql/ai', icon: 'bolt', label: 'AI', description: 'SQL from a question, explanations and table descriptions.', group: 'development', tab: 'ai' },
  { key: 'utilities', href: '/builder/sql/utilities', icon: 'wrench', label: 'Utilities', description: 'Object reports, About Database and the other utilities.', group: 'administration', tab: 'utilities', main: true },
  { key: 'backups', href: '/builder/backups', icon: 'archive', label: 'Manage Backups', description: 'Backups of the workspace\'s applications.', group: 'administration' },
  { key: 'workspaces', href: '/builder/workspaces', icon: 'layers', label: 'Workspaces', description: 'Workspaces, their developers and database roles.', group: 'administration', admin: true },
  { key: 'dbusers', href: '/builder/db-users', icon: 'key', label: 'Database Users', description: 'PostgreSQL roles: sign-in, expiry, memberships and schema privileges.', group: 'administration', admin: true },
  { key: 'datapump', href: '/builder/sql/data-pump', icon: 'archive', label: 'Schema Export / Import', description: 'A schema to a file with pg_dump, a file into a schema with pg_restore (Data Pump).', group: 'administration', tab: 'datapump', admin: true },
  { key: 'scheduling', href: '/builder/sql/scheduling', icon: 'clock', label: 'Scheduling', description: 'pg_cron jobs: SQL on a schedule, next runs, run history; pgkiln\'s automations without it.', group: 'administration', tab: 'scheduling', admin: true },
  { key: 'developers', href: '/builder/developers', icon: 'users', label: 'Developers', description: 'Builder accounts and their workspaces.', group: 'administration' },
  { key: 'monitor', href: '/builder/sql/monitor', icon: 'activity', label: 'SQL Monitor', description: 'Sessions live: what they run, wait for and what blocks them; cancel or terminate.', group: 'monitoring', tab: 'monitor', admin: true },
  { key: 'topsql', href: '/builder/sql/monitor/top', icon: 'chart', label: 'Top SQL', description: 'The slowest and most called statements of the database, with their plans.', group: 'monitoring', tab: 'monitor', admin: true },
  { key: 'about', href: '/builder/sql/utilities/about', icon: 'info', label: 'About Database', description: 'The server: version, settings, extensions and sizes.', group: 'monitoring' },
  { key: 'reports', href: '/builder/sql/utilities/reports', icon: 'list', label: 'Object Reports', description: 'Tables without keys, unindexed foreign keys, row level security gaps and more.', group: 'monitoring' },
  { key: 'activity', href: '/builder/dashboard', icon: 'chart', label: 'Monitor Activity', description: 'Page views, errors and slow pages of the applications.', group: 'monitoring' },
];
