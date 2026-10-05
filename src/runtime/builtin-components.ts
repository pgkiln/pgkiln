import type { TemplateComponent } from './template-components.ts';

// Built-in template components (APEX: the Universal Theme's template
// components: Avatar, Badge, Comments, Media List, Timeline, and 26.1's
// Metric Card). Every application can use them in a template_component
// region or as a report column template without importing anything; a
// component of the application with the same static id takes its place
// (Shared Components → Template components → Copy into this application).
// They go through the same checks as plug-ins (template-components.ts), and
// their look comes from the tc-* classes in app.css. Show a region as
// "multiple" to get the group (one list, an avatar group, a row of cards).

const STATE = '{case STATE/}{when success,ok,done,approved,active,completed,y,yes,true/}success{when warning,pending,open,waiting,in progress/}warning{when danger,error,failed,rejected,cancelled,late,n,no,false/}danger{when info,new,draft,planned/}info{otherwise/}neutral{endcase/}';

const text = (name: string, label: string, help?: string) => ({ name, label, type: 'text' as const, default: `#${name}#`, ...(help ? { help } : {}) });

export const BUILTIN_COMPONENTS: readonly TemplateComponent[] = [
  {
    static_id: 'ut_avatar',
    name: 'Avatar',
    description: 'A picture or initials in a circle or rounded square, in three sizes. As "multiple", the avatars overlap in a group.',
    template:
      '<span class="tc-avatar tc-avatar-{case SIZE/}{when small/}sm{when large/}lg{otherwise/}md{endcase/}{case SHAPE/}{when square/} tc-avatar-square{endcase/}" title="#NAME#">' +
      '{if ?IMAGE/}<img class="tc-avatar-img" src="#IMAGE#" alt="#NAME#" loading="lazy">{else/}#INITIALS#{endif/}</span>',
    wrapper: '<div class="tc-avatar-group">#APEX$ROWS#</div>',
    css_classes: ['tc-inline'],
    attributes: [
      text('NAME', 'Name', 'Shown as a tooltip and as the picture\'s text.'),
      text('INITIALS', 'Initials', 'One or two letters, shown without a picture.'),
      text('IMAGE', 'Picture URL', 'Optional: a relative or https URL.'),
      { name: 'SIZE', label: 'Size', type: 'select', options: ['small', 'medium', 'large'], default: 'medium' },
      { name: 'SHAPE', label: 'Shape', type: 'select', options: ['circle', 'square'], default: 'circle' },
    ],
  },
  {
    static_id: 'ut_badge',
    name: 'Badge',
    description: 'A short label coloured by its state (success, warning, danger, info or neutral; approved, pending, … are understood).',
    template: '<span class="tc-badge tc-badge-' + STATE + '">{if ?LINK/}<a href="#LINK#">#LABEL#</a>{else/}#LABEL#{endif/}</span>',
    wrapper: null,
    css_classes: ['tc-inline'],
    attributes: [text('LABEL', 'Label'), text('STATE', 'State', 'success, warning, danger, info or neutral (or approved, pending, …).')],
  },
  {
    static_id: 'ut_comments',
    name: 'Comments',
    description: 'A conversation: who wrote what and when, with initials. Show the region as "multiple" for one list.',
    template:
      '<li class="tc-comment"><span class="tc-avatar tc-avatar-sm" aria-hidden="true">#INITIALS#</span>' +
      '<div class="tc-stack"><p class="tc-meta"><strong class="tc-comment-user">#USER#</strong>{if ?DATE/} · <time datetime="#DATE#">#DATE#</time>{endif/}{if ?ACTIONS/} · #ACTIONS#{endif/}</p>' +
      '<p class="tc-body tc-comment-text">#COMMENT#</p></div></li>',
    wrapper: '<ul class="tc-comments">#APEX$ROWS#</ul>',
    css_classes: [],
    attributes: [text('USER', 'User'), text('INITIALS', 'Initials'), text('DATE', 'Date'), text('COMMENT', 'Comment'), text('ACTIONS', 'Extra text', 'Optional, e.g. "edited".')],
  },
  {
    static_id: 'ut_media_list',
    name: 'Media list',
    description: 'Rows with a picture or initials, a title (linked when the region has a link), a description and a badge.',
    template:
      '<li class="tc-media">{if ?IMAGE/}<img class="tc-avatar tc-avatar-md tc-avatar-square" src="#IMAGE#" alt="" loading="lazy">{else/}<span class="tc-avatar tc-avatar-md tc-avatar-square" aria-hidden="true">#INITIALS#</span>{endif/}' +
      '<div class="tc-stack"><p class="tc-title">{if ?LINK/}<a href="#LINK#">#TITLE#</a>{else/}#TITLE#{endif/}</p>{if ?DESCRIPTION/}<p class="tc-meta">#DESCRIPTION#</p>{endif/}</div>' +
      '{if ?BADGE/}<span class="tc-badge tc-badge-' + STATE + ' tc-media-badge">#BADGE#</span>{endif/}</li>',
    wrapper: '<ul class="tc-media-list">#APEX$ROWS#</ul>',
    css_classes: [],
    attributes: [
      text('TITLE', 'Title'),
      text('DESCRIPTION', 'Description'),
      text('INITIALS', 'Initials', 'Shown without a picture.'),
      text('IMAGE', 'Picture URL', 'Optional: a relative or https URL.'),
      text('BADGE', 'Badge'),
      text('STATE', 'Badge state', 'success, warning, danger, info or neutral.'),
    ],
  },
  {
    static_id: 'ut_metric_card',
    name: 'Metric card',
    description: 'A key figure with its label, unit, change and trend (up, down or flat). As "multiple", the cards share a row.',
    template:
      '<article class="tc-card tc-metric">{if ?LINK/}<a class="tc-metric-label" href="#LINK#">#LABEL#</a>{else/}<p class="tc-metric-label">#LABEL#</p>{endif/}' +
      '<p class="tc-metric-value"><data value="#VALUE#">#VALUE#</data>{if ?UNIT/} <span class="tc-metric-unit">#UNIT#</span>{endif/}</p>' +
      '{if ?CHANGE/}<p class="tc-metric-change tc-trend-{case TREND/}{when up/}up{when down/}down{otherwise/}flat{endcase/}{case GOOD/}{when down/} tc-good-down{endcase/}">' +
      '<span class="tc-trend-mark" aria-hidden="true">{case TREND/}{when up/}▲{when down/}▼{otherwise/}■{endcase/}</span> #CHANGE#</p>{endif/}' +
      '{if ?DESCRIPTION/}<p class="tc-meta">#DESCRIPTION#</p>{endif/}</article>',
    wrapper: '<div class="tc-metrics">#APEX$ROWS#</div>',
    css_classes: [],
    attributes: [
      text('LABEL', 'Label'),
      text('VALUE', 'Value'),
      text('UNIT', 'Unit'),
      text('CHANGE', 'Change', 'e.g. "+4% on last month".'),
      { name: 'TREND', label: 'Trend', type: 'text', default: '#TREND#', help: 'up, down or flat (a column or a fixed value).' },
      { name: 'GOOD', label: 'Good direction', type: 'select', options: ['up', 'down'], default: 'up', help: 'Down: a falling value shows green (e.g. costs).' },
      text('DESCRIPTION', 'Description'),
    ],
  },
  {
    static_id: 'ut_timeline',
    name: 'Timeline',
    description: 'Events on a vertical line: when, who, a title (linked when the region has a link) and a text; STATE colours the marker. Show the region as "multiple".',
    template:
      '<li class="tc-timeline-item tc-state-' + STATE + '"><p class="tc-meta"><time datetime="#WHEN#">#WHEN#</time>{if ?WHO/} · #WHO#{endif/}</p>' +
      '<p class="tc-title">{if ?LINK/}<a href="#LINK#">#TITLE#</a>{else/}#TITLE#{endif/}</p>{if ?BODY/}<p class="tc-body">#BODY#</p>{endif/}</li>',
    wrapper: '<ol class="tc-timeline">#APEX$ROWS#</ol>',
    css_classes: [],
    attributes: [text('TITLE', 'Title'), text('WHEN', 'When', 'A date or time.'), text('WHO', 'Who'), text('BODY', 'Text'), text('STATE', 'State', 'success, warning, danger, info or neutral (or approved, pending, …).')],
  },
];

/** The built-in components by static id, each marked as built in. */
export const builtinComponents = () => new Map(BUILTIN_COMPONENTS.map((c) => [c.static_id, { ...c, builtin: true as const }]));
