// (sprint 230, AX-9..11) The APEX importer's mapping of a region's Layout, Appearance, Accessibility, Advanced,
// Header and Footer and Comments (create_page_plug arguments) to pgkiln's region properties (migration 188).
// Values pgkiln would refuse (a class list with odd characters, attributes with event handlers) are left out
// with a note; the import never fails on them.
import { ApexId, type ApexValue } from './apexparse.ts';
import { isIcon } from './icons.ts';
import { attributesProblem, classList } from './runtime/region-props.ts';

type Args = Record<string, ApexValue>;
const text = (a: Args, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = a[k];
    if (v === undefined || v === null || v instanceof ApexId) continue;
    const s = Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? '' : String(x))).join('\n') : String(v);
    if (s.trim() !== '') return s;
  }
  return null;
};
const LANDMARKS = new Set(['region', 'navigation', 'search', 'complementary', 'banner', 'contentinfo', 'main']);

/** The region properties of a create_page_plug call; `span` is the region's column span, `note` reports a value left out. */
export function apexRegionProps(a: Args, span: number, note: (m: string) => void): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const classes = (key: string, label: string, to: string) => {
    const v = text(a, key);
    if (!v) return;
    // APEX's own placeholders (#DEFAULT#, &ITEM. substitutions) are not CSS classes
    const kept = v.split(/\s+/).filter((c) => c && !/[#&]/.test(c)).join(' ');
    const ok = classList(kept);
    if (ok) out[to] = ok;
    if (!ok || kept !== v.trim().split(/\s+/).join(' ')) note(`${label} "${v.slice(0, 80)}": only plain CSS class names are kept`);
  };
  // Layout: APEX starts a new row unless p_plug_new_grid_row => false; pgkiln lets a narrower region flow
  if (a.p_plug_new_grid_row !== false && a.p_plug_new_grid_row !== 'N' && span < 12) out.new_row = true;
  const col = Number(text(a, 'p_plug_grid_column', 'p_plug_display_column'));
  if (Number.isInteger(col) && col >= 1 && col <= 12) out.grid_column = col;
  classes('p_plug_grid_row_css_classes', 'Row CSS Classes', 'row_css_classes');
  classes('p_plug_grid_column_css_classes', 'Column CSS Classes', 'column_css_classes');
  // Appearance
  classes('p_region_css_classes', 'CSS Classes', 'css_classes');
  const ic = text(a, 'p_icon_css_classes');
  if (ic) {
    const name = ic.trim().split(/\s+/).find((c) => c.startsWith('fa-') && isIcon(c));
    if (name) out.icon = name;
    else note(`icon "${ic.slice(0, 60)}" is not one pgkiln knows: left out`);
  }
  const point = (text(a, 'p_plug_item_display_point') ?? '').toUpperCase();
  if (point === 'ABOVE') out.render_components = 'above';
  else if (point === 'BELOW') out.render_components = 'below';
  // Accessibility
  const lmType = (text(a, 'p_landmark_type') ?? '').toLowerCase();
  if (LANDMARKS.has(lmType)) out.landmark_type = lmType;
  else if (lmType === 'exclude' || lmType === 'none') out.use_landmark = false;
  const lmLabel = text(a, 'p_landmark_label');
  if (lmLabel) out.landmark_label = lmLabel.slice(0, 200);
  // Advanced
  for (const [key, to, label] of [['p_region_attributes', 'custom_attributes', 'Custom Attributes'], ['p_plug_grid_column_attributes', 'column_attributes', 'Column Attributes']] as const) {
    const v = text(a, key);
    if (!v) continue;
    const problem = attributesProblem(label, v);
    if (problem) note(`${problem}: left out`);
    else out[to] = v.slice(0, 2000);
  }
  if (a.p_translate_title === false || a.p_translate_title === 'N') out.title_no_translate = true;
  // Header and Footer, Comments
  const header = text(a, 'p_plug_header');
  if (header) out.header_text = header.slice(0, 20000);
  const footer = text(a, 'p_plug_footer');
  if (footer) out.footer_text = footer.slice(0, 20000);
  const comments = text(a, 'p_plug_comment');
  if (comments) out.comments = comments.slice(0, 20000);
  return out;
}
