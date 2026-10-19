import type { Kind, RawPlan } from './ir-plan.ts';

// (sprint 112) "Ask in your own words" without an AI service (APEX 26.2: AI
// interactive reports work with zero AI). A small rule-based parser turns
// common phrases into the same answer an AI service gives (a RawPlan, checked
// by checkPlan in ir-plan.ts):
//
//   salary over 3000            sort by hire date, newest first     only clerks
//   sum of salary by department where job is clerk                bonus is 10% of salary
//   highlight salary over 4000 in red    pie chart of count by department    start over
//
// The words live in phrase tables, one per language (English, Dutch and
// German here; another language adds a table to PHRASES). A question is cut
// into clauses (at commas and words such as "where", "and", "with"); each
// clause is matched against the patterns in turn. Columns are found by name
// or heading (also without spaces, and a verb such as "hired" for "hiredate");
// a bare value ("clerks", "in sales") is looked up among the report's own
// values through the lookup function (a query parameter, never SQL text).
// What isn't understood is reported, not guessed.

export interface PhraseColumn {
  name: string;
  label: string;
  kind: Kind;
}

/** A stored value matching one of the candidates (lower case), in the given column or any text column. */
export type Lookup = (column: string | null, candidates: string[]) => Promise<{ column: string; value: string; candidate: string } | null>;

export interface Phrases {
  /** words that start a new clause (besides , and ;) */
  split: string[];
  /** phrases a new clause starts at (they stay in it) */
  starts: string[];
  /** "between X and Y" */
  between: [string, string];
  /** words dropped at the start of a clause */
  stop: string[];
  reset: RegExp;
  /** sort by <column> [direction]: group 1 is the rest */
  sort: RegExp;
  desc: string[];
  asc: string[];
  /** "highest salary first" (desc) / "lowest salary first" (asc): group 1 is the column */
  firstDesc: RegExp;
  firstAsc: RegExp;
  /** highlight <condition> [in <color>]: group 1 is the rest */
  highlight: RegExp;
  colorIn: RegExp;
  colors: Record<string, string>;
  breakBy: RegExp;
  groupBy: RegExp;
  /** "by", "per", … between a measure and the group columns */
  by: string[];
  /** "and" between group or pivot columns */
  and: string[];
  pivot: RegExp;
  /** (kind)? chart (of)? rest: group 1 the kind word (may be empty), group 2 the rest */
  chart: RegExp;
  chartKinds: Record<string, string>;
  functions: [string, string][];
  of: string[];
  /** <name> is <expression>: group 1 the name, group 2 the expression */
  compute: RegExp;
  arith: [RegExp, string][];
  percentOf: RegExp;
  search: RegExp;
  /** operator phrases (longest first is not needed: sorted by length) */
  operators: [string, string][];
  /** "is empty" and the like, after a column */
  empty: [string, string][];
  /** no <column> / without <column>: group 1 */
  without: RegExp;
  /** has <column>: group 1 */
  having: RegExp;
  /** only <values>: group 1 */
  only: RegExp;
  /** not <values> / except <values>: group 1 */
  except: RegExp;
  /** replacements before a question is cut into clauses ("highlight rows where" → "highlight") */
  glue: [RegExp, string][];
  yes: string[];
  no: string[];
  months: Record<string, number>;
  thisYear: string[];
  lastYear: string[];
  /** decimal comma (3,5) and thousands dot (3.000) */
  decimalComma: boolean;
  thousand: string[];
  /** singular forms of a plural word */
  singular: (w: string) => string[];
}

const words = (s: string) => s.split(' ').filter(Boolean);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const en: Phrases = {
  split: ['where', 'whose', 'with', 'who', 'which', 'that', 'and', 'but', 'also', 'then', 'while'],
  starts: ['sorted by', 'sort by', 'order by', 'ordered by', 'sorted on', 'highlight', 'group by', 'grouped by', 'control break', 'break by', 'break on', 'pivot', 'only', 'just', 'except', 'search for'],
  between: ['between', 'and'],
  stop: ['show', 'me', 'list', 'display', 'give', 'get', 'find', 'i', 'want', 'need', 'see', 'please', 'can', 'you', 'all', 'the', 'a', 'an', 'any', 'rows', 'records', 'entries', 'everyone', 'everybody', 'people', 'those', 'them', 'are', 'is', 'was', 'were', 'be', 'who', 'which', 'that', 'whose', 'add', 'make', 'let', 'us'],
  reset: /^(?:reset|clear|clear all|clear everything|clear (?:all )?(?:the )?filters|start over|start again|remove (?:all|everything)|show everything|undo all)$/,
  sort: /^(?:sort|sorted|order|ordered|sorting)\s+(?:it\s+|them\s+)?(?:by|on)\s+(.+)$/,
  desc: ['descending', 'desc', 'high to low', 'highest first', 'largest first', 'biggest first', 'newest first', 'latest first', 'most recent first', 'last first', 'z to a', 'reversed', 'in reverse'],
  asc: ['ascending', 'asc', 'low to high', 'lowest first', 'smallest first', 'oldest first', 'earliest first', 'first first', 'a to z'],
  firstDesc: /^(?:the\s+)?(?:highest|largest|biggest|most|newest|latest|most recent|best paid|top)\s+(.+?)\s+(?:first|on top|at the top)$/,
  firstAsc: /^(?:the\s+)?(?:lowest|smallest|least|oldest|earliest|first)\s+(.+?)\s+(?:first|on top|at the top)$/,
  highlight: /^(?:highlight|mark|colou?r)\s+(?:the\s+)?(?:rows?\s+)?(?:where\s+|with\s+|whose\s+)?(.+)$/,
  colorIn: /\s+(?:in|as|with)\s+(\S+)$/,
  colors: { yellow: 'yellow', green: 'green', red: 'red', blue: 'blue', gray: 'gray', grey: 'gray' },
  breakBy: /^(?:control\s+)?break\s+(?:by|on)\s+(.+)$/,
  groupBy: /^(?:group|grouped)\s+(?:by|on|per)\s+(.+)$/,
  by: ['grouped by', 'for each', 'for every', 'in each', 'by', 'per', 'across'],
  and: ['and', '&', 'by', 'across', 'against', 'versus', 'vs', 'x'],
  pivot: /^pivot(?:\s+table)?\s+(?:of\s+)?(.+)$/,
  chart: /^(?:a\s+)?(?:(\S+)\s+)?(?:chart|graph)\s*(?:of\s+|with\s+|showing\s+)?(.*)$/,
  chartKinds: { bar: 'bar', column: 'column', line: 'line', area: 'area', pie: 'pie', donut: 'donut', doughnut: 'donut' },
  functions: [['sum', 'sum'], ['total', 'sum'], ['average', 'avg'], ['avg', 'avg'], ['mean', 'avg'], ['count', 'count'], ['number', 'count'], ['how many', 'count'], ['minimum', 'min'], ['min', 'min'], ['lowest', 'min'], ['smallest', 'min'], ['maximum', 'max'], ['max', 'max'], ['highest', 'max'], ['largest', 'max']],
  of: ['of', 'the', 'all'],
  compute: /^(?:(?:add|compute|calculate|create|make)\s+(?:a\s+)?(?:new\s+)?(?:column\s+|field\s+)?)?(?:column\s+)?([\p{L}][\p{L}\p{N}_ ]{0,39}?)\s+(?:is|=|as|equals|means)\s+(.+)$/u,
  arith: [[/\b(?:times|multiplied by)\b/g, '*'], [/\bplus\b/g, '+'], [/\b(?:minus|less)\b/g, '-'], [/\bdivided by\b/g, '/'], [/\btwice\b/g, '2 *'], [/\bhalf of\b/g, '0.5 *'], [/\bhalf\b/g, '0.5 *']],
  percentOf: /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s+of\b/g,
  search: /^(?:search|look)\s+(?:for\s+)?(.+)$/,
  operators: [
    ['is not', 'ne'], ["isn't", 'ne'], ['not equal to', 'ne'], ['other than', 'ne'], ['not', 'ne'], ['!=', 'ne'], ['<>', 'ne'], ['≠', 'ne'],
    ['is at least', 'ge'], ['at least', 'ge'], ['is greater than or equal to', 'ge'], ['>=', 'ge'], ['≥', 'ge'], ['from', 'ge'], ['since', 'ge'], ['starting', 'ge'],
    ['is at most', 'le'], ['at most', 'le'], ['up to', 'le'], ['no more than', 'le'], ['<=', 'le'], ['≤', 'le'], ['until', 'le'], ['through', 'le'],
    ['is over', 'gt'], ['over', 'gt'], ['above', 'gt'], ['is more than', 'gt'], ['more than', 'gt'], ['greater than', 'gt'], ['is greater than', 'gt'], ['higher than', 'gt'], ['bigger than', 'gt'], ['larger than', 'gt'], ['exceeds', 'gt'], ['after', 'gt'], ['later than', 'gt'], ['>', 'gt'],
    ['is under', 'lt'], ['under', 'lt'], ['below', 'lt'], ['is less than', 'lt'], ['less than', 'lt'], ['lower than', 'lt'], ['smaller than', 'lt'], ['before', 'lt'], ['earlier than', 'lt'], ['<', 'lt'],
    ['does not contain', 'not_contains'], ["doesn't contain", 'not_contains'], ['not containing', 'not_contains'], ['without the text', 'not_contains'],
    ['contains', 'contains'], ['containing', 'contains'], ['includes', 'contains'], ['like', 'contains'], ['mentions', 'contains'], ['matching', 'contains'],
    ['is in', 'in'], ['in', 'in'], ['during', 'in'], ['of', 'eq'],
    ['is equal to', 'eq'], ['equal to', 'eq'], ['equals', 'eq'], ['is', 'eq'], ['==', 'eq'], ['=', 'eq'], [':', 'eq'],
  ],
  empty: [['is not empty', 'not_null'], ['is not blank', 'not_null'], ['is set', 'not_null'], ['is known', 'not_null'], ['is empty', 'null'], ['is blank', 'null'], ['is missing', 'null'], ['is unknown', 'null'], ['is null', 'null'], ['is not null', 'not_null']],
  without: /^(?:no|without|missing|lacking|has no|with no|without a|without an)\s+(.+)$/,
  having: /^(?:having|has|having a|has a|has an|with a|with an)\s+(.+)$/,
  only: /^(?:only|just|all|show only|everyone in|in)\s+(.+)$/,
  except: /^(?:not|except|excluding|apart from|other than|no)\s+(.+)$/,
  glue: [[/\b(highlight|mark|colou?r)\s+(?:the\s+)?(?:rows?\s+)?(?:where|with|whose|that have)\s+/g, '$1 ']],
  yes: ['yes', 'true', 'y', 'on'],
  no: ['no', 'false', 'n', 'off'],
  months: { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 },
  thisYear: ['this year'],
  lastYear: ['last year'],
  decimalComma: false,
  thousand: ['k', 'thousand'],
  singular: (w) => {
    const out: string[] = [];
    if (/men$/.test(w)) out.push(w.replace(/men$/, 'man'));
    if (/ies$/.test(w)) out.push(w.replace(/ies$/, 'y'));
    if (/(ses|xes|ches|shes)$/.test(w)) out.push(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) out.push(w.slice(0, -1));
    return out;
  },
};

const nl: Phrases = {
  split: ['waar', 'waarvan', 'met', 'die', 'dat', 'en', 'maar', 'ook', 'dan'],
  starts: ['gesorteerd op', 'sorteer op', 'sorteren op', 'orden op', 'markeer', 'groepeer op', 'gegroepeerd op', 'splits op', 'draaitabel', 'alleen', 'behalve', 'zoek naar'],
  between: ['tussen', 'en'],
  stop: ['toon', 'laat', 'zien', 'me', 'mij', 'geef', 'lijst', 'alle', 'de', 'het', 'een', 'graag', 'rijen', 'iedereen', 'mensen', 'zijn', 'is', 'die', 'dat', 'wie', 'voeg', 'toe', 'maak'],
  reset: /^(?:reset|wis alles|alles wissen|wis (?:alle )?filters|begin opnieuw|opnieuw beginnen|toon alles|alles tonen)$/,
  sort: /^(?:sorteer|gesorteerd|sorteren|orden|geordend)\s+(?:op|naar)\s+(.+)$/,
  desc: ['aflopend', 'hoog naar laag', 'hoogste eerst', 'grootste eerst', 'nieuwste eerst', 'laatste eerst', 'z tot a'],
  asc: ['oplopend', 'laag naar hoog', 'laagste eerst', 'kleinste eerst', 'oudste eerst', 'eerste eerst', 'a tot z'],
  firstDesc: /^(?:de\s+|het\s+)?(?:hoogste|grootste|meeste|nieuwste|laatste|best betaalde)\s+(.+?)\s+(?:eerst|bovenaan)$/,
  firstAsc: /^(?:de\s+|het\s+)?(?:laagste|kleinste|minste|oudste|eerste)\s+(.+?)\s+(?:eerst|bovenaan)$/,
  highlight: /^(?:markeer|accentueer|kleur)\s+(?:de\s+)?(?:rijen\s+)?(?:waar\s+|met\s+|waarvan\s+)?(.+)$/,
  colorIn: /\s+(?:in|als|met)\s+(\S+)$/,
  colors: { geel: 'yellow', groen: 'green', rood: 'red', blauw: 'blue', grijs: 'gray' },
  breakBy: /^(?:splits|onderbreek|breek)\s+(?:op|per)\s+(.+)$/,
  groupBy: /^(?:groepeer|gegroepeerd|groeperen)\s+(?:op|per|naar)\s+(.+)$/,
  by: ['gegroepeerd op', 'voor elke', 'voor iedere', 'per', 'op', 'naar'],
  and: ['en', '&', 'per', 'op', 'tegen', 'x'],
  pivot: /^(?:draaitabel|pivot)\s+(?:van\s+)?(.+)$/,
  chart: /^(?:een\s+)?(?:(\S+?)\s*)?(?:grafiek|diagram)\s*(?:van\s+|met\s+)?(.*)$/,
  chartKinds: { staaf: 'bar', staafdiagram: 'bar', kolom: 'column', lijn: 'line', vlak: 'area', taart: 'pie', cirkel: 'pie', donut: 'donut' },
  functions: [['som', 'sum'], ['totaal', 'sum'], ['totale', 'sum'], ['gemiddelde', 'avg'], ['gemiddeld', 'avg'], ['aantal', 'count'], ['hoeveel', 'count'], ['minimum', 'min'], ['laagste', 'min'], ['kleinste', 'min'], ['maximum', 'max'], ['hoogste', 'max'], ['grootste', 'max']],
  of: ['van', 'de', 'het', 'alle'],
  compute: /^(?:(?:voeg|bereken|maak)\s+(?:een\s+)?(?:nieuwe\s+)?(?:kolom\s+)?)?(?:kolom\s+)?([\p{L}][\p{L}\p{N}_ ]{0,39}?)\s+(?:is|=|als|wordt)\s+(.+?)(?:\s+toe)?$/u,
  arith: [[/\b(?:keer|maal)\b/g, '*'], [/\bplus\b/g, '+'], [/\bmin\b/g, '-'], [/\bgedeeld door\b/g, '/'], [/\bhet dubbele van\b/g, '2 *'], [/\bde helft van\b/g, '0.5 *']],
  percentOf: /(\d+(?:\.\d+)?)\s*(?:%|procent)\s+van\b/g,
  search: /^(?:zoek|zoeken)\s+(?:naar\s+|op\s+)?(.+)$/,
  operators: [
    ['is niet', 'ne'], ['niet gelijk aan', 'ne'], ['anders dan', 'ne'], ['niet', 'ne'], ['!=', 'ne'], ['<>', 'ne'], ['≠', 'ne'],
    ['is minstens', 'ge'], ['minstens', 'ge'], ['ten minste', 'ge'], ['minimaal', 'ge'], ['vanaf', 'ge'], ['sinds', 'ge'], ['>=', 'ge'], ['≥', 'ge'],
    ['is hoogstens', 'le'], ['hoogstens', 'le'], ['ten hoogste', 'le'], ['maximaal', 'le'], ['tot en met', 'le'], ['<=', 'le'], ['≤', 'le'],
    ['boven', 'gt'], ['meer dan', 'gt'], ['groter dan', 'gt'], ['hoger dan', 'gt'], ['is meer dan', 'gt'], ['is groter dan', 'gt'], ['na', 'gt'], ['later dan', 'gt'], ['>', 'gt'],
    ['onder', 'lt'], ['minder dan', 'lt'], ['kleiner dan', 'lt'], ['lager dan', 'lt'], ['is minder dan', 'lt'], ['voor', 'lt'], ['vóór', 'lt'], ['eerder dan', 'lt'], ['<', 'lt'],
    ['bevat niet', 'not_contains'], ['bevat', 'contains'], ['met de tekst', 'contains'], ['lijkt op', 'contains'],
    ['is in', 'in'], ['in', 'in'], ['tijdens', 'in'],
    ['is gelijk aan', 'eq'], ['gelijk aan', 'eq'], ['is', 'eq'], ['=', 'eq'], [':', 'eq'],
  ],
  empty: [['is niet leeg', 'not_null'], ['is ingevuld', 'not_null'], ['is bekend', 'not_null'], ['is leeg', 'null'], ['ontbreekt', 'null'], ['is onbekend', 'null']],
  without: /^(?:geen|zonder)\s+(.+)$/,
  having: /^(?:heeft|hebben|met een)\s+(.+)$/,
  only: /^(?:alleen|enkel|uitsluitend|iedereen in|in|bij)\s+(.+)$/,
  except: /^(?:niet|behalve|zonder|geen)\s+(.+)$/,
  glue: [[/\b(markeer|accentueer|kleur)\s+(?:de\s+)?(?:rijen\s+)?(?:waar|met|waarvan)\s+/g, '$1 ']],
  yes: ['ja', 'waar', 'true'],
  no: ['nee', 'onwaar', 'false'],
  months: { januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7, augustus: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12 },
  thisYear: ['dit jaar'],
  lastYear: ['vorig jaar', 'afgelopen jaar'],
  decimalComma: true,
  thousand: ['k', 'duizend'],
  singular: (w) => {
    const out: string[] = [];
    if (/'s$/.test(w)) out.push(w.slice(0, -2));
    if (/s$/.test(w)) out.push(w.slice(0, -1));
    if (/en$/.test(w)) out.push(w.slice(0, -2));
    return out;
  },
};

const de: Phrases = {
  split: ['wo', 'wobei', 'mit', 'und', 'aber', 'auch', 'dann', 'deren', 'dessen'],
  starts: ['sortiert nach', 'sortiere nach', 'sortieren nach', 'ordne nach', 'markiere', 'hebe', 'gruppiere nach', 'gruppiert nach', 'kontrollgruppe', 'pivot', 'nur', 'außer', 'suche nach'],
  between: ['zwischen', 'und'],
  stop: ['zeige', 'zeig', 'mir', 'liste', 'alle', 'gib', 'bitte', 'den', 'die', 'der', 'das', 'ein', 'eine', 'einen', 'zeilen', 'datensätze', 'jeder', 'leute', 'sind', 'ist', 'füge', 'hinzu', 'erstelle'],
  reset: /^(?:zurücksetzen|alles zurücksetzen|alle filter entfernen|filter löschen|neu anfangen|von vorne|alles zeigen|alles anzeigen)$/,
  sort: /^(?:sortiere|sortiert|sortieren|ordne|geordnet)\s+(?:nach|auf)\s+(.+)$/,
  desc: ['absteigend', 'hoch nach niedrig', 'höchste zuerst', 'größte zuerst', 'neueste zuerst', 'z bis a'],
  asc: ['aufsteigend', 'niedrig nach hoch', 'niedrigste zuerst', 'kleinste zuerst', 'älteste zuerst', 'a bis z'],
  firstDesc: /^(?:das\s+|die\s+|der\s+)?(?:höchste|höchstes|höchsten|größte|größtes|meiste|neueste|neuesten|best bezahlte)\s+(.+?)\s+(?:zuerst|oben)$/,
  firstAsc: /^(?:das\s+|die\s+|der\s+)?(?:niedrigste|niedrigstes|kleinste|wenigste|älteste|ältesten|erste)\s+(.+?)\s+(?:zuerst|oben)$/,
  highlight: /^(?:markiere|hebe|färbe)\s+(?:die\s+)?(?:zeilen\s+)?(?:wo\s+|mit\s+|deren\s+)?(.+?)(?:\s+hervor)?$/,
  colorIn: /\s+(?:in|als|mit)\s+(\S+)$/,
  colors: { gelb: 'yellow', grün: 'green', gruen: 'green', rot: 'red', blau: 'blue', grau: 'gray' },
  breakBy: /^(?:kontrollgruppe|gruppenwechsel|trenne)\s+(?:nach|auf|bei)\s+(.+)$/,
  groupBy: /^(?:gruppiere|gruppiert|gruppieren)\s+(?:nach|pro)\s+(.+)$/,
  by: ['gruppiert nach', 'für jede', 'für jeden', 'pro', 'je', 'nach'],
  and: ['und', '&', 'nach', 'gegen', 'x'],
  pivot: /^pivot(?:tabelle)?\s+(?:von\s+|aus\s+)?(.+)$/,
  chart: /^(?:ein\s+|eine\s+)?(?:(\S+?)\s*)?(?:diagramm|grafik|chart)\s*(?:von\s+|mit\s+|über\s+)?(.*)$/,
  chartKinds: { balken: 'bar', säulen: 'column', saeulen: 'column', linien: 'line', linie: 'line', flächen: 'area', kreis: 'pie', torten: 'pie', donut: 'donut', ring: 'donut' },
  functions: [['summe', 'sum'], ['gesamt', 'sum'], ['durchschnitt', 'avg'], ['mittelwert', 'avg'], ['durchschnittliche', 'avg'], ['anzahl', 'count'], ['wie viele', 'count'], ['minimum', 'min'], ['niedrigste', 'min'], ['kleinste', 'min'], ['maximum', 'max'], ['höchste', 'max'], ['größte', 'max']],
  of: ['von', 'der', 'des', 'die', 'das', 'aller'],
  compute: /^(?:(?:füge|berechne|erstelle)\s+(?:eine\s+)?(?:neue\s+)?(?:spalte\s+)?)?(?:spalte\s+)?([\p{L}][\p{L}\p{N}_ ]{0,39}?)\s+(?:ist|=|als|sind)\s+(.+?)(?:\s+hinzu)?$/u,
  arith: [[/\b(?:mal|multipliziert mit)\b/g, '*'], [/\bplus\b/g, '+'], [/\bminus\b/g, '-'], [/\bgeteilt durch\b/g, '/'], [/\bdas doppelte von\b/g, '2 *'], [/\bdie hälfte von\b/g, '0.5 *']],
  percentOf: /(\d+(?:\.\d+)?)\s*(?:%|prozent)\s+(?:von|des|der)\b/g,
  search: /^(?:suche|suchen)\s+(?:nach\s+)?(.+)$/,
  operators: [
    ['ist nicht', 'ne'], ['ungleich', 'ne'], ['nicht', 'ne'], ['!=', 'ne'], ['<>', 'ne'], ['≠', 'ne'],
    ['ist mindestens', 'ge'], ['mindestens', 'ge'], ['ab', 'ge'], ['seit', 'ge'], ['>=', 'ge'], ['≥', 'ge'],
    ['ist höchstens', 'le'], ['höchstens', 'le'], ['bis', 'le'], ['<=', 'le'], ['≤', 'le'],
    ['über', 'gt'], ['mehr als', 'gt'], ['größer als', 'gt'], ['höher als', 'gt'], ['ist größer als', 'gt'], ['nach', 'gt'], ['später als', 'gt'], ['>', 'gt'],
    ['unter', 'lt'], ['weniger als', 'lt'], ['kleiner als', 'lt'], ['niedriger als', 'lt'], ['ist kleiner als', 'lt'], ['vor', 'lt'], ['früher als', 'lt'], ['<', 'lt'],
    ['enthält nicht', 'not_contains'], ['enthält', 'contains'], ['mit dem text', 'contains'], ['wie', 'contains'],
    ['ist in', 'in'], ['in', 'in'], ['im', 'in'], ['während', 'in'],
    ['ist gleich', 'eq'], ['gleich', 'eq'], ['ist', 'eq'], ['=', 'eq'], [':', 'eq'],
  ],
  empty: [['ist nicht leer', 'not_null'], ['ist gesetzt', 'not_null'], ['ist bekannt', 'not_null'], ['ist leer', 'null'], ['fehlt', 'null'], ['ist unbekannt', 'null']],
  without: /^(?:kein|keine|keinen|ohne)\s+(.+)$/,
  having: /^(?:hat|haben|mit einem|mit einer)\s+(.+)$/,
  only: /^(?:nur|lediglich|ausschließlich|alle in|in|bei|im)\s+(.+)$/,
  except: /^(?:nicht|außer|ausser|ohne|kein|keine)\s+(.+)$/,
  glue: [[/\b(markiere|hebe|färbe)\s+(?:die\s+)?(?:zeilen\s+)?(?:wo|mit|deren)\s+/g, '$1 ']],
  yes: ['ja', 'wahr', 'true'],
  no: ['nein', 'falsch', 'false'],
  months: { januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12 },
  thisYear: ['dieses jahr', 'in diesem jahr'],
  lastYear: ['letztes jahr', 'im letzten jahr', 'vorjahr'],
  decimalComma: true,
  thousand: ['k', 'tausend'],
  singular: (w) => {
    const out: string[] = [];
    if (/en$/.test(w)) out.push(w.slice(0, -2), w.slice(0, -1));
    if (/[en]$/.test(w)) out.push(w.slice(0, -1));
    if (/s$/.test(w)) out.push(w.slice(0, -1));
    return out;
  },
};

/** The phrase tables by language (base language code). English is always tried too. */
export const PHRASES: Record<string, Phrases> = { en, nl, de };

// ------------------------------------------------------------------ parsing

interface State {
  P: Phrases;
  columns: PhraseColumn[];
  lookup: Lookup;
  today: string;
  plan: Required<Pick<RawPlan, 'filters' | 'highlights' | 'aggregates' | 'group_by' | 'group_functions' | 'computed_columns'>> & RawPlan;
  left: string[];
  understood: number;
  /** the last column a condition was about ("salary over 1000 and under 3000") */
  lastCol: PhraseColumn | null;
  /** the previous clause set a group by (a bare column after it adds to it) */
  lastGroup: boolean;
  /** the previous clause was a sort (a bare direction after it applies to it) */
  lastSort: boolean;
  /** quoted text, put back when a value is read */
  quoted: string[];
  /** "pivot sum of salary by department" waiting for its pivot column ("and job" became the next clause) */
  pendingPivot: { fn: string; value: string; row: string } | null;
}

const flat = (s: string) => s.replace(/[\s_]+/g, '');
const startsWithWord = (s: string, w: string) => s === w || s.startsWith(`${w} `) || (/^\W/.test(w) && s.startsWith(w));
const afterWord = (s: string, w: string) => s.slice(w.length).trim();

/** Column aliases: name, name with spaces, heading (all without spaces for comparing). */
function aliases(c: PhraseColumn) {
  const label = c.label.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ');
  return [...new Set([flat(c.name.toLowerCase()), flat(label)].filter(Boolean))];
}

/** The column a text starts with (longest match), and the rest. */
function matchColumn(st: State, s: string): { col: PhraseColumn; rest: string } | null {
  const w = words(s);
  for (let n = Math.min(4, w.length); n >= 1; n--) {
    const phrase = flat(w.slice(0, n).join(' '));
    const forms = [phrase, ...st.P.singular(phrase)];
    const col = st.columns.find((c) => aliases(c).some((a) => forms.includes(a)));
    if (col) return { col, rest: w.slice(n).join(' ') };
  }
  // a verb or a part of a name: "hired" → hiredate, "commission" → comm (one column only)
  const first = w[0] ?? '';
  if (first.length >= 4) {
    const stems = [first, first.replace(/(ed|d|ing|s)$/, ''), first.replace(/(ed|ing)$/, '')].filter((x) => x.length >= 4);
    const found = st.columns.filter((c) => aliases(c).some((a) => stems.some((x) => a.startsWith(x) || (a.length >= 4 && x.startsWith(a)))));
    if (found.length === 1) return { col: found[0], rest: w.slice(1).join(' ') };
  }
  return null;
}

const stripStop = (st: State, s: string) => {
  let w = words(s);
  while (w.length > 1 && st.P.stop.includes(w[0])) w = w.slice(1);
  return w.join(' ');
};

const unquote = (st: State, s: string) => s.replace(/\u0002(\d+)\u0002/g, (_, i) => st.quoted[Number(i)] ?? '').trim();

function parseNumber(st: State, s: string): { n: string; rest: string } | null {
  const m = /^(?:[$€£]\s*)?(-?\d+(?:\.\d+)?)\s*([a-z]+)?\b(.*)$/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  let rest = `${m[2] ?? ''} ${m[3]}`.trim();
  const unit = m[2] ?? '';
  if (unit && st.P.thousand.includes(unit)) (n *= 1000), (rest = m[3].trim());
  return { n: String(n), rest: rest.replace(/^(?:euro|eur|dollars?|usd)\b\s*/, '') };
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A date or period at the start of the text: its first and last day. */
function parseDate(st: State, s: string): { start: string; end: string; rest: string } | null {
  const year = Number(st.today.slice(0, 4));
  for (const [list, y] of [[st.P.thisYear, year], [st.P.lastYear, year - 1]] as [string[], number][])
    for (const p of list) if (startsWithWord(s, p)) return { start: `${y}-01-01`, end: `${y}-12-31`, rest: afterWord(s, p) };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b(.*)$/.exec(s);
  if (m) {
    const d = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    return +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? { start: d, end: d, rest: m[4].trim() } : null;
  }
  const month = (w: string) => st.P.months[w.replace(/\.$/, '')];
  // 1 june 1981 / june 1 1981 / june 1981 / 1981
  m = /^(\d{1,2})(?:st|nd|rd|th|e|\.)?\s+(\p{L}+)\.?\s+(\d{4})\b(.*)$/u.exec(s);
  if (m && month(m[2])) return { start: `${m[3]}-${pad(month(m[2]))}-${pad(+m[1])}`, end: `${m[3]}-${pad(month(m[2]))}-${pad(+m[1])}`, rest: m[4].trim() };
  m = /^(\p{L}+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})\b(.*)$/u.exec(s);
  if (m && month(m[1])) return { start: `${m[3]}-${pad(month(m[1]))}-${pad(+m[2])}`, end: `${m[3]}-${pad(month(m[1]))}-${pad(+m[2])}`, rest: m[4].trim() };
  m = /^(\p{L}+)\.?\s+(\d{4})\b(.*)$/u.exec(s);
  if (m && month(m[1])) {
    const mm = month(m[1]);
    return { start: `${m[2]}-${pad(mm)}-01`, end: `${m[2]}-${pad(mm)}-${pad(lastDay(+m[2], mm))}`, rest: m[3].trim() };
  }
  m = /^(1[89]\d\d|2\d\d\d)\b(.*)$/.exec(s);
  if (m) return { start: `${m[1]}-01-01`, end: `${m[1]}-12-31`, rest: m[2].trim() };
  return null;
}

type Filter = { column: string; operator: string; value: string };

/** Candidates for a value lookup: the first 1–5 words (and their singular forms), longest first. */
function candidates(st: State, s: string) {
  const w = words(unquote(st, s));
  const out: { text: string; n: number }[] = [];
  for (let n = Math.min(5, w.length); n >= 1; n--) {
    const text = w.slice(0, n).join(' ');
    out.push({ text, n });
    for (const x of st.P.singular(w[n - 1])) out.push({ text: [...w.slice(0, n - 1), x].join(' '), n });
  }
  return { out, w };
}

/** A value of a column at the start of the text: the conditions and the rest. */
async function valueCondition(st: State, col: PhraseColumn, op: string, s: string): Promise<{ filters: Filter[]; rest: string } | null> {
  s = s.trim();
  if (!s) return null;
  if (col.kind === 'number') {
    const n = parseNumber(st, s);
    if (!n) return null;
    if (op === 'in' || op === 'eq') return { filters: [{ column: col.name, operator: 'eq', value: n.n }], rest: n.rest };
    return { filters: [{ column: col.name, operator: op, value: n.n }], rest: n.rest };
  }
  if (col.kind === 'date') {
    const d = parseDate(st, s);
    if (!d) return null;
    const one = d.start === d.end;
    const f = (operator: string, value: string): Filter => ({ column: col.name, operator, value });
    switch (op) {
      case 'gt': return { filters: [f('gt', d.end)], rest: d.rest };
      case 'ge': return { filters: [f('ge', d.start)], rest: d.rest };
      case 'lt': return { filters: [f('lt', d.start)], rest: d.rest };
      case 'le': return { filters: [f('le', d.end)], rest: d.rest };
      case 'ne': return one ? { filters: [f('ne', d.start)], rest: d.rest } : null;
      default: return { filters: one ? [f('eq', d.start)] : [f('ge', d.start), f('le', d.end)], rest: d.rest };
    }
  }
  if (col.kind === 'boolean') {
    const w = words(s);
    const yes = st.P.yes.includes(w[0]);
    if (!yes && !st.P.no.includes(w[0])) return null;
    return { filters: [{ column: col.name, operator: op === 'ne' ? 'ne' : 'eq', value: String(yes) }], rest: w.slice(1).join(' ') };
  }
  // text: "contains" takes the rest; otherwise a stored value (case as stored), else the words as a contains
  if (op === 'contains' || op === 'not_contains') return { filters: [{ column: col.name, operator: op, value: unquote(st, s) }], rest: '' };
  const { out, w } = candidates(st, s);
  const found = await st.lookup(col.name, out.map((c) => c.text.toLowerCase()));
  if (found) {
    const n = out.find((c) => c.text.toLowerCase() === found.candidate)?.n ?? w.length;
    const operator = op === 'ne' ? 'ne' : ['gt', 'ge', 'lt', 'le'].includes(op) ? op : 'eq';
    return { filters: [{ column: col.name, operator, value: found.value }], rest: w.slice(n).join(' ') };
  }
  const value = unquote(st, s);
  if (op === 'ne') return { filters: [{ column: col.name, operator: 'not_contains', value }], rest: '' };
  if (['gt', 'ge', 'lt', 'le'].includes(op)) return { filters: [{ column: col.name, operator: op, value: w[0] }], rest: w.slice(1).join(' ') };
  return { filters: [{ column: col.name, operator: 'contains', value }], rest: '' };
}

/** A condition on a column: "<op> <value>", "between a and b", "is empty", or a bare value. */
async function condition(st: State, col: PhraseColumn, s: string): Promise<{ filters: Filter[]; rest: string } | null> {
  s = s.trim();
  const P = st.P;
  for (const [phrase, op] of [...P.empty].sort((a, b) => b[0].length - a[0].length))
    if (startsWithWord(s, phrase)) return { filters: [{ column: col.name, operator: op, value: '' }], rest: afterWord(s, phrase) };
  const [bw, band] = P.between;
  if (startsWithWord(s, bw)) {
    const m = new RegExp(`^${esc(bw)}\\s+(.+?)\\s+${esc(band)}\\s+(.+)$`).exec(s);
    if (!m) return null;
    const a = await valueCondition(st, col, 'ge', m[1]);
    const b = await valueCondition(st, col, 'le', m[2]);
    if (!a || !b || a.rest) return null;
    return { filters: [...a.filters.slice(0, 1), ...b.filters.slice(-1)], rest: b.rest };
  }
  if (!s) return col.kind === 'boolean' ? { filters: [{ column: col.name, operator: 'eq', value: 'true' }], rest: '' } : null;
  for (const [phrase, op] of [...P.operators].sort((a, b) => b[0].length - a[0].length))
    if (startsWithWord(s, phrase)) {
      const r = await valueCondition(st, col, op, afterWord(s, phrase));
      if (r) return r;
    }
  return valueCondition(st, col, 'eq', s);
}

/** A stored value of any shown text column at the start of the text ("clerks", "sales"). */
async function bareValue(st: State, s: string, negate: boolean): Promise<{ filters: Filter[]; rest: string } | null> {
  const { out, w } = candidates(st, s);
  if (!out.length) return null;
  const found = await st.lookup(null, out.map((c) => c.text.toLowerCase()));
  if (!found) return null;
  const n = out.find((c) => c.text.toLowerCase() === found.candidate)?.n ?? w.length;
  return { filters: [{ column: found.column, operator: negate ? 'ne' : 'eq', value: found.value }], rest: w.slice(n).join(' ') };
}

/** Function phrase at the start: the function and the rest (after "of", "the"). */
function matchFunction(st: State, s: string) {
  for (const [phrase, fn] of [...st.P.functions].sort((a, b) => b[0].length - a[0].length))
    if (startsWithWord(s, phrase)) {
      let rest = words(afterWord(s, phrase));
      while (rest.length && st.P.of.includes(rest[0])) rest = rest.slice(1);
      return { fn, rest: rest.join(' ') };
    }
  return null;
}

/** "<left> by <right>": the first group phrase that splits the text. */
function splitBy(st: State, s: string, phrases = st.P.by): [string, string] | null {
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    const i = ` ${s} `.indexOf(` ${p} `);
    if (i >= 0) return [s.slice(0, Math.max(0, i - 1)).trim(), s.slice(i + p.length).trim()];
  }
  return null;
}

/** Columns separated by "and", "," or the like; null unless all are columns. */
function columnList(st: State, s: string): PhraseColumn[] | null {
  const out: PhraseColumn[] = [];
  let rest = s.trim();
  while (rest) {
    const m = matchColumn(st, stripStop(st, rest));
    if (!m) return null;
    out.push(m.col);
    rest = m.rest;
    const sep = st.P.and.find((a) => startsWithWord(rest, a));
    if (sep) rest = afterWord(rest, sep);
    else if (rest) return null;
  }
  return out.length ? out : null;
}

/** A measure: "<fn> of <column>", "<column>" (sum or count), or nothing (count of the first column). */
function measure(st: State, s: string): { fn: string; column: string } | null {
  const first = st.columns[0];
  s = stripStop(st, s);
  const f = matchFunction(st, s);
  if (f) {
    const m = f.rest ? matchColumn(st, f.rest) : null;
    if (m && !m.rest) return { fn: f.fn, column: m.col.name };
    return f.fn === 'count' && first ? { fn: 'count', column: first.name } : null;
  }
  if (!s) return first ? { fn: 'count', column: first.name } : null;
  const m = matchColumn(st, s);
  if (m && !m.rest) return { fn: m.col.kind === 'number' ? 'sum' : 'count', column: m.col.name };
  return null;
}

/** An expression in words ("10% of salary", "salary times 12") as a computed column expression, or null. */
function expression(st: State, s: string): string | null {
  let e = unquote(st, s).replace(st.P.percentOf, (_, n) => `${Number(n) / 100} * `);
  for (const [re, op] of st.P.arith) e = e.replace(re, ` ${op} `);
  // words → column names; numbers, operators, parentheses and the compute functions stay
  const tokens = e.match(/"[^"]*"|'[^']*'|\d+(?:\.\d+)?|\|\||[-+*/(),]|[\p{L}_][\p{L}\p{N}_$]*/gu) ?? [];
  const out: string[] = [];
  let usesColumn = false;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (!/^[\p{L}_]/u.test(tk)) {
      out.push(tk);
      continue;
    }
    if (tokens[i + 1] === '(') {
      out.push(tk);
      continue;
    }
    if (st.P.of.includes(tk)) continue;
    // the longest run of words that is a column
    let j = i;
    while (j + 1 < tokens.length && /^[\p{L}_]/u.test(tokens[j + 1]) && j - i < 3) j++;
    let done = false;
    for (let k = j; k >= i; k--) {
      const m = matchColumn(st, tokens.slice(i, k + 1).join(' '));
      if (m && !m.rest) {
        out.push(/^[a-z_][a-z0-9_$]*$/.test(m.col.name) ? m.col.name : `"${m.col.name.replace(/"/g, '')}"`);
        usesColumn = true;
        i = k;
        done = true;
        break;
      }
    }
    if (!done) return null;
  }
  return usesColumn && out.length ? out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',') : null;
}

/** The rest of a clause after something understood: parsed as a clause of its own. */
async function more(st: State, rest: string) {
  if (!(await clause(st, rest))) st.left.push(unquote(st, rest));
  return true;
}

/** One clause; true when it was understood. */
async function clause(st: State, raw: string): Promise<boolean> {
  const P = st.P;
  const plan = st.plan;
  let s = stripStop(st, raw.trim());
  if (!s) return true;
  const wasGroup = st.lastGroup;
  const pivot = st.pendingPivot;
  st.pendingPivot = null;
  if (pivot) {
    const c = matchColumn(st, s);
    if (c && !c.rest && c.col.name !== pivot.row) return (plan.pivot = { row: pivot.row, column: c.col.name, function: pivot.fn, value: pivot.value }), true;
    st.left.push(`pivot ${pivot.row}`);
  }
  const wasSort = st.lastSort;
  st.lastGroup = false;
  st.lastSort = false;
  if (P.reset.test(s)) return (plan.reset = true);

  // a direction after a sort ("sort by hire date, newest first")
  if (wasSort && [...P.desc, ...P.asc].includes(s)) return (plan.sort_descending = P.desc.includes(s)), (st.lastSort = true);
  let m: RegExpExecArray | null;
  if ((m = P.sort.exec(s))) {
    const c = matchColumn(st, stripStop(st, m[1]));
    if (!c) return false;
    plan.sort_column = c.col.name;
    plan.sort_descending = P.desc.includes(c.rest);
    if (c.rest && !P.desc.includes(c.rest) && !P.asc.includes(c.rest)) return more(st, c.rest);
    return (st.lastSort = true);
  }
  if ((m = P.firstDesc.exec(s)) || (m = P.firstAsc.exec(s))) {
    const c = matchColumn(st, stripStop(st, m[1]));
    if (c && !c.rest) {
      plan.sort_column = c.col.name;
      plan.sort_descending = P.firstDesc.test(s);
      return true;
    }
  }
  if ((m = P.search.exec(s))) {
    plan.search = unquote(st, m[1]);
    return true;
  }
  if ((m = P.highlight.exec(s))) {
    let rest = m[1];
    let color = 'yellow';
    const cm = P.colorIn.exec(rest);
    if (cm && P.colors[cm[1]]) (color = P.colors[cm[1]]), (rest = rest.slice(0, cm.index));
    const w = words(rest);
    if (P.colors[w[0]]) (color = P.colors[w[0]]), (rest = w.slice(1).join(' '));
    const c = matchColumn(st, stripStop(st, rest));
    const r = c ? await condition(st, c.col, c.rest) : await bareValue(st, rest, false);
    if (!r || r.rest) return false;
    for (const f of r.filters) plan.highlights.push({ ...f, color });
    return true;
  }
  if ((m = P.breakBy.exec(s))) {
    const c = matchColumn(st, stripStop(st, m[1]));
    if (!c || c.rest) return false;
    plan.control_break = c.col.name;
    return true;
  }
  if ((m = P.groupBy.exec(s))) {
    const cols = columnList(st, m[1]);
    if (!cols) return false;
    plan.group_by.push(...cols.map((c) => c.name));
    return (st.lastGroup = true);
  }
  if ((m = P.pivot.exec(s))) {
    const by = splitBy(st, m[1]);
    if (!by) return false;
    // "pivot sum of salary by department and job" or "pivot department by job"
    const left = measure(st, by[0]);
    const cols = columnList(st, by[1]);
    const asRow = matchColumn(st, by[0]);
    if (left && cols?.length === 2 && matchFunction(st, by[0])) {
      plan.pivot = { row: cols[0].name, column: cols[1].name, function: left.fn, value: left.column };
      return true;
    }
    if (left && cols?.length === 1 && matchFunction(st, by[0])) {
      st.pendingPivot = { fn: left.fn, value: left.column, row: cols[0].name };
      return true;
    }
    if (asRow && !asRow.rest && cols?.length === 1 && st.columns[0]) {
      plan.pivot = { row: asRow.col.name, column: cols[0].name, function: 'count', value: st.columns[0].name };
      return true;
    }
    return false;
  }
  if ((m = P.chart.exec(s)) && (!m[1] || P.chartKinds[m[1]] || P.of.includes(m[1]) || P.stop.includes(m[1]))) {
    const kind = (m[1] && P.chartKinds[m[1]]) || 'bar';
    const by = splitBy(st, m[2]);
    if (!by) return false;
    const label = matchColumn(st, stripStop(st, by[1]));
    const v = measure(st, by[0]);
    if (!label || label.rest || !v) return false;
    plan.chart = { type: kind, label: label.col.name, function: v.fn, value: v.column };
    return true;
  }
  // an aggregate: "sum of salary by department" (group by), "total salary" (a totals row)
  const fm = matchFunction(st, s);
  if (fm) {
    const by = splitBy(st, fm.rest);
    if (by) {
      const v = by[0] ? matchColumn(st, stripStop(st, by[0])) : null;
      const first = st.columns[0];
      const fn = v && !v.rest ? { fn: fm.fn, column: v.col.name } : fm.fn === 'count' && first ? { fn: 'count', column: first.name } : null;
      const cols = columnList(st, by[1]);
      if (cols && fn) {
        plan.group_by.push(...cols.map((c) => c.name));
        plan.group_functions.push({ function: fn.fn, column: fn.column });
        return (st.lastGroup = true);
      }
    } else {
      const c = fm.rest ? matchColumn(st, fm.rest) : null;
      if (c && !c.rest) {
        plan.aggregates.push({ function: fm.fn, column: c.col.name });
        return true;
      }
    }
  }
  // a computed column: "bonus is 10% of salary" (the name is not a column)
  if ((m = P.compute.exec(s)) && !matchColumn(st, m[1])) {
    const expr = expression(st, m[2]);
    if (expr) {
      plan.computed_columns.push({ name: m[1].trim(), expression: expr });
      return true;
    }
  }
  // no <column> / has <column>
  if ((m = P.without.exec(s))) {
    const c = matchColumn(st, stripStop(st, m[1]));
    if (c && !c.rest) return plan.filters.push({ column: c.col.name, operator: 'null', value: '' }), true;
  }
  if ((m = P.having.exec(s))) {
    const c = matchColumn(st, stripStop(st, m[1]));
    if (c && !c.rest) return plan.filters.push({ column: c.col.name, operator: 'not_null', value: '' }), true;
  }
  // a column and a condition
  const c = matchColumn(st, s);
  if (c) {
    // a bare column after a group by adds to it ("by department and job")
    if (!c.rest && wasGroup) return plan.group_by.push(c.col.name), (st.lastGroup = true);
    const r = await condition(st, c.col, c.rest);
    if (r) {
      st.lastCol = c.col;
      plan.filters.push(...r.filters);
      return r.rest ? more(st, r.rest) : true;
    }
  }
  // a condition on the column before ("salary over 1000 and under 3000")
  if (st.lastCol && P.operators.some(([p]) => startsWithWord(s, p))) {
    const r = await condition(st, st.lastCol, s);
    if (r) {
      plan.filters.push(...r.filters);
      return r.rest ? more(st, r.rest) : true;
    }
  }
  // values: "only clerks", "not clerks", "clerks", "in sales"
  const neg = P.except.exec(s);
  const only = P.only.exec(s);
  if (only || neg) {
    const b = matchColumn(st, stripStop(st, (only ?? neg)![1]));
    if (b && !b.rest && b.col.kind === 'boolean') return plan.filters.push({ column: b.col.name, operator: 'eq', value: String(!neg) }), true;
  }
  const r = neg ? await bareValue(st, neg[1], true) : await bareValue(st, only ? only[1] : s, false);
  if (r) {
    plan.filters.push(...r.filters);
    return r.rest ? more(st, r.rest) : true;
  }
  return false;
}

/** Cut a question into clauses (outside "between … and …"). */
function clauses(st: State, q: string) {
  const P = st.P;
  let s = q;
  for (const [re, to] of P.glue) s = s.replace(re, to);
  // between a and b: protect the "and"
  const [bw, band] = P.between;
  s = s.replace(new RegExp(`\\b${esc(bw)}\\s+(\\S+(?:\\s+\\S+){0,2}?)\\s+${esc(band)}\\s+`, 'gu'), `${bw} $1 \u0001 `);
  for (const p of [...P.starts].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(`(^|\\s)(${esc(p)})(?=\\s|$)`, 'gu'), '$1; $2');
  const sep = new RegExp(`\\s+(?:${P.split.map(esc).join('|')})\\s+`, 'gu');
  return s
    .split(/[;,]/)
    .flatMap((x) => ` ${x} `.split(sep))
    .map((x) => x.replace(/\u0001/g, band).trim())
    .filter(Boolean);
}

/** Normalise a question for one language: lower case, quotes kept aside, numbers without separators. */
function normalise(P: Phrases, question: string, quoted: string[]) {
  let s = question.replace(/["“”]([^"“”]{1,200})["“”]/g, (_, x) => `\u0002${quoted.push(x) - 1}\u0002`).toLowerCase();
  s = s.replace(/[‘’]/g, "'").replace(/[?!]+/g, ' ').replace(/\.(\s|$)/g, '$1');
  s = s.replace(/(\d{1,2}),\s*(\d{4})\b/g, '$1 $2');
  s = P.decimalComma ? s.replace(/(\d)\.(\d{3})\b/g, '$1$2').replace(/(\d),(\d)/g, '$1.$2') : s.replace(/(\d),(\d{3})\b/g, '$1$2');
  // "salary>3000" → "salary > 3000"
  s = s.replace(/\s*(>=|<=|!=|<>|==|[<>=≠≥≤])\s*/g, ' $1 ');
  return s.replace(/\s+/g, ' ').trim();
}

export interface ParseResult {
  plan: RawPlan;
  /** the clauses not understood */
  left: string[];
  understood: number;
}

async function parseWith(P: Phrases, question: string, columns: PhraseColumn[], lookup: Lookup, today: string): Promise<ParseResult> {
  const st: State = {
    P, columns, lookup, today, quoted: [], left: [], understood: 0, lastCol: null, lastGroup: false, lastSort: false, pendingPivot: null,
    plan: { filters: [], highlights: [], aggregates: [], group_by: [], group_functions: [], computed_columns: [] },
  };
  const s = normalise(P, question, st.quoted);
  for (const c of clauses(st, s)) {
    if (await clause(st, c)) st.understood++;
    else st.left.push(unquote(st, c));
  }
  if (st.pendingPivot) st.left.push(`pivot ${st.pendingPivot.row}`);
  // two values of one column can't both hold (filters are and-ed): keep the first, say so
  const seen = new Set<string>();
  st.plan.filters = st.plan.filters.filter((f) => {
    if (f.operator !== 'eq') return true;
    if (seen.has(f.column)) {
      st.left.push(f.value);
      return false;
    }
    seen.add(f.column);
    return true;
  });
  return { plan: st.plan, left: st.left, understood: st.understood };
}

/**
 * Parse a question with the phrases of the user's language (when pgkiln has
 * them) and English, and keep the reading that understood most.
 */
export async function parseQuestion(question: string, columns: PhraseColumn[], lang: string, lookup: Lookup, today = new Date().toISOString().slice(0, 10)): Promise<ParseResult> {
  const base = lang.toLowerCase().split('-')[0];
  const tables = [...new Set([base, 'en'])].filter((l) => PHRASES[l]).map((l) => PHRASES[l]);
  let best: ParseResult | null = null;
  for (const P of tables) {
    const r = await parseWith(P, question.slice(0, 500), columns, lookup, today);
    if (!best || r.understood - r.left.length > best.understood - best.left.length) best = r;
    if (!r.left.length && r.understood) break;
  }
  return best!;
}
