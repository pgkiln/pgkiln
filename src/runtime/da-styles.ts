// (sprint 156, CD-3) The Set Style dynamic action: CSS properties from a fixed list, with plain values. The builder
// refuses others (styleProblem); the page only ever gets the ones that pass (safeStyles), set through the CSSOM
// (element.style), which the Content-Security-Policy allows without 'unsafe-inline'.

export const STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'border-color', 'outline-color', 'font-weight', 'font-style', 'font-size', 'text-decoration', 'text-transform',
  'text-align', 'opacity', 'visibility', 'border-width', 'border-style', 'padding', 'margin', 'width', 'max-width', 'min-height',
]);
/** colours, lengths, keywords, numbers: no url(), quotes, semicolons, braces, backslashes or expressions */
const VALUE = /^[#a-zA-Z0-9 .,%()+-]{1,60}$/;
const BAD = /url\s*\(|expression|var\s*\(|attr\s*\(|image|\/\*/i;

export function styleProblem(styles: unknown): string | null {
  if (styles === undefined || styles === null) return 'Set style: {"styles": {"color": "#b42318", "font-weight": "bold"}} in the attributes.';
  if (typeof styles !== 'object' || Array.isArray(styles)) return 'Set style: "styles" is an object of CSS properties and values.';
  const entries = Object.entries(styles as Record<string, unknown>);
  if (!entries.length || entries.length > 10) return 'Set style: 1 to 10 properties.';
  for (const [k, v] of entries) {
    if (!STYLE_PROPERTIES.has(k)) return `Set style: ${k} isn't one of ${[...STYLE_PROPERTIES].join(', ')}.`;
    if (typeof v !== 'string' || !VALUE.test(v) || BAD.test(v)) return `Set style: the value of ${k} is a colour, length or keyword (letters, digits, # . , % ( ) + -), without url() or var().`;
  }
  return null;
}

/** The properties of a Set Style action that pass, as {property: value}. */
export function safeStyles(config: Record<string, any> | null | undefined): Record<string, string> {
  const s = config?.styles;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => STYLE_PROPERTIES.has(k) && typeof v === 'string' && VALUE.test(v) && !BAD.test(v)).slice(0, 10)) as Record<string, string>;
}

/** The client-side comparison of greater / less conditions: numbers as numbers, ISO dates as dates, else text. */
export function compareValues(a: string, b: string): number {
  const num = /^\s*-?\d+(\.\d+)?\s*$/;
  if (num.test(a) && num.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
