-- =====================================================================
-- HR example, part 19: template components and plug-ins
-- (docs/guide/04-pages-and-regions.md, "Template components")
--
-- The three plug-ins in examples/plugins/ are installed with
-- meta.import_template_component() (the builder imports the same files
-- under Shared Components → Template components → Add). Page 19 "Team"
-- shows employees as contact cards (a template_component region that
-- links to the employee form for managers), recent hires on a timeline
-- (the "multiple" display, inside the component's wrapper), and leave
-- requests in a report whose status column is a status badge.
-- =====================================================================

select meta.import_template_component(a.id, $plugin${
  "format": "pgapex-plugin/1",
  "type": "template_component",
  "static_id": "status_badge",
  "name": "Status badge",
  "version": "1.0.0",
  "description": "A coloured pill for a status. STATE picks the colour: success, warning, danger, info or neutral; common words like approved, pending, rejected and Y/N are understood too.",
  "template": "<span class=\"tc-badge tc-badge-{case STATE/}{when success,ok,done,approved,active,completed,y,yes,true/}success{when warning,pending,open,waiting,in progress/}warning{when danger,error,failed,rejected,cancelled,late,n,no,false/}danger{when info,new,draft,planned/}info{otherwise/}neutral{endcase/}\">#LABEL#</span>",
  "wrapper": null,
  "css_classes": [
    "tc-inline"
  ],
  "attributes": [
    {
      "name": "LABEL",
      "label": "Label",
      "type": "text",
      "default": "#STATUS#",
      "help": "The text; by default the status column."
    },
    {
      "name": "STATE",
      "label": "State",
      "type": "text",
      "default": "#STATUS#",
      "help": "success, warning, danger, info or neutral (or approved, pending, rejected, Y, N…)."
    }
  ]
}$plugin$::jsonb)
  from meta.app a where a.alias = 'hr';

select meta.import_template_component(a.id, $plugin${
  "format": "pgapex-plugin/1",
  "type": "template_component",
  "static_id": "contact_card",
  "name": "Contact card",
  "version": "1.0.0",
  "description": "A person or organisation with initials, a subtitle, e-mail and phone links and tags. The name links to #LINK# when the region sets a link.",
  "template": "<article class=\"tc-card\">\n  <div class=\"tc-card-head\">\n    <span class=\"tc-avatar\" aria-hidden=\"true\">#INITIALS#</span>\n    <div class=\"tc-stack\">\n      <h3 class=\"tc-title\">{if ?LINK/}<a href=\"#LINK#\">#NAME#</a>{else/}#NAME#{endif/}</h3>\n      {if ?SUBTITLE/}<p class=\"tc-meta\">#SUBTITLE#</p>{endif/}\n    </div>\n  </div>\n  {if ?EMAIL/}<p class=\"tc-meta\"><a href=\"mailto:#EMAIL#\">#EMAIL#</a></p>{endif/}\n  {if ?PHONE/}<p class=\"tc-meta\"><a href=\"tel:#PHONE#\">#PHONE#</a></p>{endif/}\n  {if ?TAGS/}<p class=\"tc-row\">{loop \",\" TAGS/}<span class=\"tc-badge tc-badge-info\">#APEX$ITEM#</span>{endloop/}</p>{endif/}\n</article>",
  "wrapper": null,
  "css_classes": [
    "tc-grid"
  ],
  "attributes": [
    {
      "name": "NAME",
      "label": "Name",
      "type": "text",
      "default": "#NAME#"
    },
    {
      "name": "INITIALS",
      "label": "Initials",
      "type": "text",
      "default": "#INITIALS#",
      "help": "One or two letters in the circle."
    },
    {
      "name": "SUBTITLE",
      "label": "Subtitle",
      "type": "text",
      "default": "#SUBTITLE#",
      "help": "e.g. job title or company."
    },
    {
      "name": "EMAIL",
      "label": "E-mail",
      "type": "text",
      "default": "#EMAIL#"
    },
    {
      "name": "PHONE",
      "label": "Phone",
      "type": "text",
      "default": "#PHONE#"
    },
    {
      "name": "TAGS",
      "label": "Tags",
      "type": "text",
      "default": "#TAGS#",
      "help": "Comma separated."
    }
  ]
}$plugin$::jsonb)
  from meta.app a where a.alias = 'hr';

select meta.import_template_component(a.id, $plugin${
  "format": "pgapex-plugin/1",
  "type": "template_component",
  "static_id": "timeline_item",
  "name": "Timeline item",
  "version": "1.0.0",
  "description": "Events on a vertical timeline: when, who, a title and a text. Show a region as \"multiple\" so the items sit in one list; STATE colours the marker.",
  "template": "<li class=\"tc-timeline-item tc-state-{case STATE/}{when success,ok,done,approved,active,completed,y,yes,true/}success{when warning,pending,open,waiting,in progress/}warning{when danger,error,failed,rejected,cancelled,late,n,no,false/}danger{when info,new,draft,planned/}info{otherwise/}neutral{endcase/}\">\n  <p class=\"tc-meta\"><time datetime=\"#WHEN#\">#WHEN#</time>{if ?WHO/} · #WHO#{endif/}</p>\n  <p class=\"tc-title\">{if ?LINK/}<a href=\"#LINK#\">#TITLE#</a>{else/}#TITLE#{endif/}</p>\n  {if ?BODY/}<p class=\"tc-body\">#BODY#</p>{endif/}\n</li>",
  "wrapper": "<ol class=\"tc-timeline\">#APEX$ROWS#</ol>",
  "css_classes": [],
  "attributes": [
    {
      "name": "TITLE",
      "label": "Title",
      "type": "text",
      "default": "#TITLE#"
    },
    {
      "name": "WHEN",
      "label": "When",
      "type": "text",
      "default": "#WHEN#",
      "help": "A date or time."
    },
    {
      "name": "WHO",
      "label": "Who",
      "type": "text",
      "default": "#WHO#"
    },
    {
      "name": "BODY",
      "label": "Text",
      "type": "text",
      "default": "#BODY#"
    },
    {
      "name": "STATE",
      "label": "State",
      "type": "text",
      "default": "#STATE#",
      "help": "success, warning, danger, info or neutral (or approved, pending…)."
    }
  ]
}$plugin$::jsonb)
  from meta.app a where a.alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 19, 'Team', 'Team', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Team', 'template_component', 8,
   $q$select e.empno, initcap(e.ename) as name, left(e.ename, 1) as initials,
       initcap(e.job) || coalesce(' · ' || initcap(d.dname), '') as subtitle,
       lower(e.ename) || '@example.com' as email,
       concat_ws(',', initcap(d.loc), case when exists (select 1 from hr.emp x where x.mgr = e.empno and x.active) then 'Manager' end) as tags
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where e.active
 order by e.ename$q$,
   '{"component": "contact_card", "link": {"page": 3, "items": {"P3_EMPNO": "#empno#"}}}'),
  (20, 'Recent hires', 'template_component', 4,
   $q$select initcap(e.ename) as title, e.hiredate as "when", initcap(e.job) as who,
       'Joined ' || coalesce(initcap(d.dname), 'the company') as body,
       case when row_number() over (order by e.hiredate desc) = 1 then 'new' end as state
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where e.active
 order by e.hiredate desc
 limit 6$q$,
   '{"component": "timeline_item", "display": "multiple"}'),
  (30, 'Leave requests', 'report', 12,
   $q$select l.id, initcap(e.ename) as employee, l.start_date, l.end_date, l.days, l.status
  from hr.leave_request l join hr.emp e on e.empno = l.empno
 order by l.start_date desc$q$,
   '{"page_size": 10, "headings": {"id": "Request", "employee": "Employee", "start_date": "From", "end_date": "To", "days": "Days", "status": "Status"}, "column_templates": {"status": {"component": "status_badge"}}}')
  ) as r (seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 19;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 30, 'Team', 'users', 19
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Team', 'Team'),
  ('Recent hires', 'Nieuwe collega''s'),
  ('Request', 'Aanvraag'),
  ('From', 'Van'),
  ('To', 'Tot'),
  ('Days', 'Dagen')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
