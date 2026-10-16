-- ---------------------------------------------------------------------
-- 110: SQL Workshop charts (sprint 97, Database Actions DA-6: Charts).
-- A chart is a SELECT with how to draw it: the chart type, the label
-- column and the value columns. The worksheet's Chart tab saves one; SQL
-- Workshop → Charts lists them and shows the ones on the dashboard. Shared
-- by the workspace's developers, like SQL Scripts. The builder runs the
-- SELECT read-only with the workshop's connection when it draws a chart.
-- Installation data, not exported.
-- ---------------------------------------------------------------------
create table meta.sql_chart (
  id            int generated always as identity primary key,
  workspace_id  int not null default 1 references meta.workspace on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  sql           text not null check (length(sql) between 1 and 20000),
  kind          text not null default 'bar' check (kind in ('bar', 'column', 'line', 'area', 'donut', 'pie', 'scatter', 'stacked')),
  label_col     text not null default '',
  value_cols    text[] not null default '{}',
  on_dashboard  boolean not null default true,
  created_by    text,
  updated_at    timestamptz not null default now(),
  unique (workspace_id, name)
);
comment on table meta.sql_chart is 'SQL Workshop charts: a SELECT drawn as a chart (110); installation data, not exported';
