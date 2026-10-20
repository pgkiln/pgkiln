-- =====================================================================
-- Sample app "Sample Cards" (App Gallery → Sample Apps)
--
-- Cards in all the forms pgkiln has: a cards region with title, subtitle,
-- body, badge and icon that opens a form; KPI tiles (style metric); a list
-- region as cards, badges, links and tabs; and the built-in template
-- components (media list, metric cards, badges, avatars) as cards.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-cards.sql
-- then open /a/sample-cards and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_cards;

create table sample_cards.product (
  id          int generated always as identity primary key,
  name        text not null unique,
  category    text not null check (category in ('Furniture', 'Lighting', 'Accessories', 'Plants')),
  price       numeric(10, 2) not null check (price >= 0),
  stock       int not null default 0 check (stock >= 0),
  rating      int check (rating between 1 and 5),
  icon        text not null default 'box',
  description text
);

insert into sample_cards.product (name, category, price, stock, rating, icon, description) values
  ('Oak desk', 'Furniture', 640, 12, 5, 'briefcase', 'A solid oak desk, 160 by 80 cm, with a cable tray.'),
  ('Task chair', 'Furniture', 290, 3, 4, 'user', 'Adjustable seat, arms and lumbar support.'),
  ('Bookcase', 'Furniture', 210, 0, 4, 'book', 'Five shelves of birch plywood.'),
  ('Desk lamp', 'Lighting', 79, 25, 5, 'lightbulb', 'Warm LED light with a dimmer.'),
  ('Floor lamp', 'Lighting', 149, 7, 3, 'sun', 'A reading light that bends where you need it.'),
  ('Monitor arm', 'Accessories', 95, 40, 4, 'tool', 'Holds one screen up to 32 inches.'),
  ('Desk mat', 'Accessories', 29, 60, 4, 'layers', 'Felt, 90 by 40 cm.'),
  ('Cable box', 'Accessories', 24, 2, 3, 'box', 'Hides a power strip and its cables.'),
  ('Fiddle-leaf fig', 'Plants', 59, 9, 5, 'leaf', 'Large leaves; likes bright, indirect light.'),
  ('Snake plant', 'Plants', 35, 18, 4, 'leaf', 'Thrives on neglect.');

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_cards') then create role app_sample_cards nologin; end if;
end $$;
grant app_sample_cards to pgkiln_runtime;
grant usage on schema sample_cards to app_sample_cards;
grant select, insert, update, delete on all tables in schema sample_cards to app_sample_cards;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-cards', 'Sample Cards', 1, 'app_users', 'app_sample_cards');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-cards';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values
  (1, 'Sample Cards', null), (2, 'Cards', 1), (4, 'KPI tiles', 1), (5, 'Lists as cards', 1), (6, 'Template components', 1)
  ) as p (no, name, parent)
 where a.alias = 'sample-cards';

-- page 3: the product form, a modal dialog opened from the cards (the Form wizard)
select meta.generate_page('sample-cards', 'form', 'sample_cards.product', 3,
  '{"label": "Product", "mode": "modal", "return_page": 2, "nav": false}');
update meta.page set parent_page = 2 where id = pg_temp.page_id('sample-cards', 3);
update meta.item set type = 'select', lov = 'STATIC:Furniture,Lighting,Accessories,Plants'
 where page_id = pg_temp.page_id('sample-cards', 3) and name = 'P3_CATEGORY';
update meta.item set type = 'rating'
 where page_id = pg_temp.page_id('sample-cards', 3) and name = 'P3_RATING';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Cards', 'layers', 2), (30, 'KPI tiles', 'dashboard', 4),
  (40, 'Lists as cards', 'list', 5), (50, 'Template components', 'grid', 6)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-cards';

insert into meta.list (app_id, name, type, description, query)
select a.id, l.name, l.type, l.description, l.query
  from meta.app a, (values
  ('CARD_TOPICS', 'static', 'The pages of Sample Cards', null),
  ('CATEGORIES', 'sql', 'The categories with the number of products, from a query',
   E'select category as label, 2 as page, null::jsonb as items,\n       case category when ''Furniture'' then ''briefcase'' when ''Lighting'' then ''lightbulb'' when ''Plants'' then ''leaf'' else ''box'' end as icon,\n       count(*)::text as badge, count(*) filter (where stock = 0) || '' out of stock'' as description\n  from sample_cards.product group by category order by category')
  ) as l (name, type, description, query)
 where a.alias = 'sample-cards';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'CARD_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Cards', 'layers', 2, 'A cards region: title, subtitle, body, badge and icon from the query, each card a link to the form.'),
  (20, 'KPI tiles', 'dashboard', 4, 'Key figures as tiles: the style metric, a format mask and an empty text.'),
  (30, 'Lists as cards', 'list', 5, 'A list (Shared Components) shown as cards, badges, links or tabs.'),
  (40, 'Template components', 'grid', 6, 'Media list, metric cards, badges and avatars: the built-in template components.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-cards';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select pg_temp.page_id('sample-cards', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb
  from (values
  -- 1 Home
  (1, 10, 'Sample Cards', 'static', 12, 'hero',
   '<p>Cards show rows as tiles instead of table rows: good for a few dozen things with a name, a picture or icon and a key figure. pgkiln has a cards region, KPI tiles, lists shown as cards and template components; this application shows each on a page of its own.</p>',
   '{"icon": "layers"}'),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "CARD_TOPICS", "template": "cards"}'),

  -- 2 Cards
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A <strong>cards</strong> region reads the columns <code>title</code>, <code>subtitle</code>, <code>body</code>, <code>badge</code> and <code>icon</code> of its query; other columns can be used in its link. Here every card opens the product form as a dialog (the attribute <code>link</code>), and the badge shows the price with a format mask.</p>',
   '{}'),
  (2, 10, 'Products', 'cards', 12, 'plain',
   E'select name as title, category || '' · '' || stock || '' in stock'' as subtitle, description as body,\n       price as badge, icon, id\n  from sample_cards.product order by category, name',
   '{"link": {"page": 3, "items": {"P3_ID": "#id#"}}, "formats": {"badge": "FML999G990D00"}, "empty": "No products yet."}'),

  -- 4 KPI tiles
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">With <code>{"style": "metric"}</code> a cards region shows KPI tiles: the <code>badge</code> as a big value and the <code>title</code> as its label. A query with no rows shows the region''s <code>empty</code> text instead.</p>',
   '{}'),
  (4, 10, 'Key figures', 'cards', 12, 'plain',
   E'select ''Products'' as title, count(*)::text as badge, ''box'' as icon from sample_cards.product\nunion all\nselect ''Stock value'', to_char(sum(price * stock), ''FM999G999G990''), ''coins'' from sample_cards.product\nunion all\nselect ''Average rating'', to_char(avg(rating), ''FM0D0''), ''star'' from sample_cards.product\nunion all\nselect ''Out of stock'', count(*) filter (where stock = 0)::text, ''alert'' from sample_cards.product',
   '{"style": "metric"}'),
  (4, 20, 'Stock per category', 'cards', 12, 'standard',
   E'select category as title, sum(stock)::text as badge,\n       case category when ''Furniture'' then ''briefcase'' when ''Lighting'' then ''lightbulb'' when ''Plants'' then ''leaf'' else ''box'' end as icon\n  from sample_cards.product group by category order by category',
   '{"style": "metric"}'),
  (4, 30, 'Products to reorder today', 'cards', 12, 'standard',
   E'select name as title, stock || '' left'' as subtitle, ''alert'' as icon from sample_cards.product where stock < 0',
   '{"empty": "Nothing to reorder: every product has stock. (This region''s query finds no rows, so it shows its empty text.)"}'),

  -- 5 Lists as cards
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A <strong>list</strong> region shows a list from Shared Components → Lists with a template: <code>cards</code>, <code>badges</code>, <code>links</code> or <code>tabs</code>. The list here comes from a query (a dynamic list): a label, a page, an icon, a badge and a description per row.</p>',
   '{}'),
  (5, 10, 'Categories as cards', 'list', 12, 'standard', null, '{"list": "CATEGORIES", "template": "cards"}'),
  (5, 20, 'Categories as badges', 'list', 6, 'standard', null, '{"list": "CATEGORIES", "template": "badges"}'),
  (5, 30, 'Categories as links', 'list', 6, 'standard', null, '{"list": "CATEGORIES", "template": "links"}'),
  (5, 40, 'Categories as tabs', 'list', 12, 'standard', null, '{"list": "CATEGORIES", "template": "tabs"}'),

  -- 6 Template components
  (6, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A <strong>template component</strong> region draws each row of its query through a component; shown as <code>multiple</code>, the rows go into the component''s group. These are the built-in components every application has: <code>ut_metric_card</code>, <code>ut_media_list</code>, <code>ut_badge</code> and <code>ut_avatar</code>.</p>',
   '{}'),
  (6, 10, 'Metric cards', 'template_component', 12, 'standard',
   E'select category as label, sum(stock)::text as value, ''in stock'' as unit,\n       count(*) || '' products'' as change, case when min(stock) = 0 then ''down'' else ''up'' end as trend, ''up'' as good\n  from sample_cards.product group by category order by category',
   '{"component": "ut_metric_card", "display": "multiple"}'),
  (6, 20, 'Media list', 'template_component', 6, 'standard',
   E'select id, name as title, description, upper(left(name, 2)) as initials,\n       to_char(price, ''FM999G990D00'') as badge, case when stock = 0 then ''danger'' when stock < 5 then ''warning'' else ''success'' end as state\n  from sample_cards.product order by name limit 6',
   '{"component": "ut_media_list", "display": "multiple", "link": {"page": 3, "items": {"P3_ID": "#id#"}}}'),
  (6, 30, 'Badges', 'template_component', 6, 'standard',
   E'select name as label, case when stock = 0 then ''danger'' when stock < 5 then ''warning'' else ''success'' end as state\n  from sample_cards.product order by name',
   '{"component": "ut_badge", "display": "multiple"}'),
  (6, 40, 'Avatars', 'template_component', 12, 'standard',
   E'select name, upper(left(name, 2)) as initials from sample_cards.product order by name',
   '{"component": "ut_avatar", "display": "multiple", "attributes": {"SIZE": "medium"}}')
  ) as r (page, seq, title, type, cols, template, source, config);
