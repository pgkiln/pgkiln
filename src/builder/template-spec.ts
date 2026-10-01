import { componentProblem, LAYOUT_CLASSES } from '../runtime/template-components.ts';
import type { ComponentSpec } from './components.ts';

// Shared Components → Template components: the property form (components.ts
// generates it from this spec). The editor's extras (attributes, preview,
// plug-in export and import) are in templates.ts.

const EXAMPLE = `<span class="tc-badge tc-badge-{case STATE/}{when ok/}success{when late/}danger{otherwise/}neutral{endcase/}">#LABEL#</span>`;

export const TEMPLATE_COMPONENT_SPEC: ComponentSpec = {
  table: 'meta.template_component',
  scope: 'app',
  label: 'Template component',
  plural: 'Template components',
  icon: 'layers',
  summary: (c) => c.name,
  defaults: {
    static_id: 'status_badge',
    name: 'Status badge',
    template: EXAMPLE,
    css_classes: ['tc-inline'],
    attributes: [
      { name: 'LABEL', label: 'Label', type: 'text', default: '#STATUS#' },
      { name: 'STATE', label: 'State', type: 'select', options: ['ok', 'late', 'other'], default: 'other' },
    ],
  },
  validate: (v) => {
    // an empty attributes field is an empty list
    if (v.attributes === '{}') v.attributes = '[]';
    let attributes: unknown;
    try {
      attributes = JSON.parse(String(v.attributes ?? '[]'));
    } catch {
      return 'Attributes: not valid JSON.';
    }
    return componentProblem({ ...v, attributes } as never);
  },
  fields: [
    { name: 'name', label: 'Name', kind: 'text', group: 'Identification' },
    { name: 'static_id', label: 'Static id', kind: 'text', group: 'Identification',
      help: 'lower case, e.g. status_badge. Regions and report columns refer to the component by it, also in other applications that import it.' },
    { name: 'version', label: 'Version', kind: 'text', group: 'Identification', help: 'Of the plug-in, e.g. 1.0.0.' },
    { name: 'description', label: 'Description', kind: 'text', wide: true, group: 'Identification' },
    { name: 'template', label: 'Template (one instance)', kind: 'code', wide: true, group: 'Template',
      help: 'HTML with #NAME# substitutions (always escaped; #NAME!STRIPHTML# drops tags first): custom attributes, the row\'s columns, #LINK# (the link set where it is used), #APEX$ROW_NUM#. Directives: {if NAME/}…{elsif ?NAME/}…{else/}…{endif/} (?NAME: not empty, !NAME: not true), {case NAME/}{when a/}…{when b,c/}…{otherwise/}…{endcase/}, {loop "," NAME/}#APEX$ITEM# #APEX$I#{endloop/}. No scripts, event handlers, style or data-* attributes; quote every attribute value.' },
    { name: 'wrapper', label: 'Wrapper (multiple)', kind: 'code', wide: true, group: 'Template',
      help: 'Optional: the frame around all rows when a region shows them as "multiple", with #APEX$ROWS# where the rows go, e.g. <ol class="tc-timeline">#APEX$ROWS#</ol>.' },
    { name: 'css_classes', label: 'Layout classes', kind: 'list', group: 'Template',
      help: `How the instances sit in a region, comma separated: ${LAYOUT_CLASSES.join(', ')}. Empty: tc-list.` },
    { name: 'attributes', label: 'Custom attributes (JSON)', kind: 'json', wide: true, group: 'Attributes',
      help: '[{"name": "LABEL", "label": "Label", "type": "text", "default": "#STATUS#"}, {"name": "STATE", "type": "select", "options": ["ok", "late"]}, {"name": "COMPACT", "type": "checkbox"}] · type: text, number, select, checkbox (Y/N). Set per use; values may contain #COLUMN# and &ITEM. substitutions.' },
  ],
};
