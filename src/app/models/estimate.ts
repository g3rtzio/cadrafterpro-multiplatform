// Estimate data in the style of PlanSwift: every element (takeoff item or PDF markup group)
// and every Part has a list of properties. A property has a formula; its result is calculated.
//   [Name]  → value of the property "Name" of the same element
//   [..]    → value of the property with the same name on the parent (a Part's element)
//   [Parts:Name] → sum of the property "Name" of the parts right below (each one already
//                  includes its own parts), e.g. "[Qty] * [Price Each] + [Parts:Price Total]"
//   + - * / ( ) and numbers. Anything else is plain text.
//   js: …   → JavaScript code (see formula-script.ts)
// The result is in the input units and is shown converted to the output units (see units.ts).

import { isScriptFormula, runScript, scriptCode } from './formula-script';
import { convertUnits } from './units';

export type PropType = 'number' | 'text';

export interface PropertyDef {
  name: string;
  group: string;
  type: PropType;
  formula: string;              // "12.5", "[Qty] * [Cost Each]", "[..]", "Part"
  inputUnits: string;           // "$", "%", "EA"… (shown next to the formula)
  units: string;                // output units (shown next to the result)
  decimals: number;
  takeoff?: boolean;            // calculated from the plan, the formula can't be edited
}

// Part: an estimate line without a measurement. It hangs from an element or another part
// (parentKey = element name or part id), or sits on its own (parentKey = null).
export interface Part {
  id: string;
  parentKey: string | null;
  props: PropertyDef[];
}

// Column of the estimate table: a property name (or Name, Pages, Color) shown for every row
export interface ColumnDef {
  id: string;
  name: string;
  type: PropType;
  visible: boolean;
  showUnits: boolean;           // adds a "Units" column right after this one
  decimals: number;
  width?: number;               // pixels (dragging the edge of the header); empty = automatic
}

// Group of rows made by the user in the estimate (rows are matched by name)
export interface EstimateGroup { id: string; name: string; rowNames: string[]; }

// Everything saved with the drawing (inside the PDF, see pdf-file.ts)
export interface EstimateData {
  version: 1;
  groups: EstimateGroup[];
  elementProps: Record<string, PropertyDef[]>;   // element name → its properties (once edited)
  parts: Part[];
  columns: ColumnDef[];
}

export const PROPERTY_GROUPS = ['Item', 'Estimating', 'Takeoff Data', 'Work Breakdown Structure'];
export const TAKEOFF_PROPS = ['Area', 'Linear Total', 'Segment Count', 'Point Count', 'Section Count'];

// Measured values of an element (from the plan)
export interface TakeoffValues {
  'Area': number;
  'Linear Total': number;
  'Segment Count': number;
  'Point Count': number;
  'Section Count': number;
}

export type ElementKind = 'area' | 'length' | 'count';

function prop(name: string, group: string, formula = '', extra: Partial<PropertyDef> = {}): PropertyDef {
  return { name, group, type: 'number', formula, inputUnits: '', units: '', decimals: 2, ...extra };
}

function text(name: string, group: string, formula = ''): PropertyDef {
  return prop(name, group, formula, { type: 'text' });
}

function estimatingProps(qtyFormula: string, qtyUnits: string): PropertyDef[] {
  const g = 'Estimating';
  return [
    prop('Qty', g, qtyFormula, { units: qtyUnits }),
    prop('Cost Each', g, '', { inputUnits: '$', units: '$' }),
    prop('Markup %', g, '', { inputUnits: '%', units: '%' }),
    text('Cost Type', g),
    prop('Cost Total', g, TOTAL_FORMULAS['Cost Total'], { inputUnits: '$', units: '$' }),
    prop('Markup Each', g, '[Cost Each] * ([Markup %] / 100)'),
    prop('Markup Total', g, TOTAL_FORMULAS['Markup Total'], { inputUnits: '$', units: '$' }),
    prop('Price Each', g, '[Cost Each] + [Markup Each]', { inputUnits: '$', units: '$' }),
    prop('Price Total', g, TOTAL_FORMULAS['Price Total'], { inputUnits: '$', units: '$' }),
  ];
}

// Totals of a row add up the totals of its parts (the price of an element includes its parts)
const TOTAL_FORMULAS: Record<string, string> = {
  'Cost Total': '[Qty] * [Cost Each] + [Parts:Cost Total]',
  'Markup Total': '[Qty] * [Markup Each] + [Parts:Markup Total]',
  'Price Total': '[Qty] * [Price Each] + [Parts:Price Total]',
};
const OLD_TOTAL_FORMULAS: Record<string, string> = {
  'Cost Total': '[Qty] * [Cost Each]', 'Markup Total': '[Qty] * [Markup Each]', 'Price Total': '[Qty] * [Price Each]',
};

// Volume of an element: calculated with formulas from what was measured and its Width / Depth
// (feet → cubic feet; change the formula to "/ 27" for cubic yards)
function volumeProps(kind: ElementKind): PropertyDef[] {
  const t = 'Takeoff Data';
  const formula = { area: '[Area] * [Depth]', length: '[Linear Total] * [Width] * [Depth]', count: '[Point Count] * [Volume Each]' }[kind];
  return [
    ...(kind === 'length' ? [prop('Width', t, '', { inputUnits: 'FT', units: 'FT' })] : []),
    ...(kind === 'count' ? [prop('Volume Each', t, '', { inputUnits: 'CF', units: 'CF' })]
      : [prop('Depth', t, '', { inputUnits: 'FT', units: 'FT' })]),
    prop('Volume', t, formula, { units: 'CF' }),
  ];
}

function wbsProps(): PropertyDef[] {
  const g = 'Work Breakdown Structure';
  return [text('Division', g), text('SubDivision', g), text('Phase', g), text('Cost Code', g)];
}

// Properties of a measured element (Area, Linear or Count)
// markupType: a PDF markup that isn't a measurement ("Highlight", "Cloud"…) shows that as its Type
export function elementTemplate(kind: ElementKind, name: string, markupType?: string | null): PropertyDef[] {
  const qty = { area: ['[Area]', 'SF'], length: ['[Linear Total]', 'LF'], count: ['[Point Count]', 'EA'] }[kind];
  const typeName = markupType || { area: 'Area', length: 'Linear', count: 'Count' }[kind];
  const t = 'Takeoff Data';
  return [
    text('Name', 'Item', name), text('Type', 'Item', typeName), text('Description', 'Item'),
    ...estimatingProps(qty[0], qty[1]),
    prop('Area', t, '', { units: 'SF', takeoff: true }),
    prop('Linear Total', t, '', { units: 'LF', takeoff: true }),
    prop('Segment Count', t, '', { decimals: 0, takeoff: true }),
    prop('Point Count', t, '', { decimals: 0, takeoff: true }),
    prop('Section Count', t, '', { units: 'EA', decimals: 0, takeoff: true }),
    ...volumeProps(kind),
    ...wbsProps(),
  ];
}

// Properties of a new Part: its quantity and takeoff data come from its parent ([..])
export function partTemplate(name = 'New Part'): PropertyDef[] {
  const t = 'Takeoff Data';
  return [
    text('Name', 'Item', name), text('Type', 'Item', 'Part'), text('Description', 'Item'),
    ...estimatingProps('[..]', ''),
    prop('Area', t, '[..]'), prop('Linear Total', t, '[..]'),
    prop('Segment Count', t, '[..]'), prop('Point Count', t, '[..]'),
    prop('Section Count', t, '[..]', { inputUnits: 'EA', units: 'EA' }),
    prop('Volume', t, '[..]', { units: 'CF' }),
    ...wbsProps(),
  ];
}

// Lists saved before these changes: no "Item #", Volume added, totals that include the parts.
// Changes the list in place; running it again does nothing. kind = null for a part.
export function upgradeProps(props: PropertyDef[], kind: ElementKind | null): PropertyDef[] {
  const item = props.findIndex(p => p.name === 'Item #');
  if (item >= 0) props.splice(item, 1);
  for (const [name, formula] of Object.entries(TOTAL_FORMULAS)) {
    const def = findProp(props, name);
    if (def && def.formula.replace(/\s+/g, ' ').trim() === OLD_TOTAL_FORMULAS[name]) def.formula = formula;
  }
  if (!findProp(props, 'Volume')) {
    const fresh = kind ? volumeProps(kind) : [prop('Volume', 'Takeoff Data', '[..]', { units: 'CF' })];
    const add = fresh.filter(p => !findProp(props, p.name));
    const after = props.findIndex(p => p.name === 'Section Count');
    props.splice(after >= 0 ? after + 1 : props.length, 0, ...add);
  }
  return props;
}

export function defaultColumns(): ColumnDef[] {
  const col = (name: string, type: PropType, visible: boolean, showUnits = false, decimals = 2): ColumnDef =>
    ({ id: `col-${name}`, name, type, visible, showUnits, decimals });
  return [
    col('Name', 'text', true),
    col('Description', 'text', false),
    col('Color', 'text', false),
    col('Qty', 'number', true, true),
    col('Cost Each', 'number', false),
    col('Markup %', 'number', false),
    col('Price Each', 'number', false),
    col('Price Total', 'number', true),
    col('Pages', 'text', true),
  ];
}

export function emptyEstimate(): EstimateData {
  return { version: 1, groups: [], elementProps: {}, parts: [], columns: defaultColumns() };
}

// MARK: - Formula evaluation

// What a property is calculated from
export interface EvalNode {
  props: PropertyDef[];
  takeoff: TakeoffValues | null;   // elements: values measured on the plan
  parent: EvalNode | null;         // parts: the element (or part) they hang from
  children?: () => EvalNode[];     // parts right below (for [Parts:…])
}

export interface EvalResult {
  value: number | string;          // number, or text for text properties and plain text formulas
  units: string;
  error?: string;
}

export function findProp(props: PropertyDef[], name: string): PropertyDef | undefined {
  const key = name.trim().toLowerCase();
  return props.find(p => p.name.trim().toLowerCase() === key);
}

export function evaluate(node: EvalNode, name: string, seen: Set<string> = new Set()): EvalResult {
  const result = evaluateRaw(node, name, seen);
  // Input units → output units (12 IN → 1 FT); units that can't be converted leave the value as is
  const def = findProp(node.props, name);
  if (def && typeof result.value === 'number' && def.inputUnits && def.units) {
    const converted = convertUnits(result.value, def.inputUnits, def.units);
    if (converted !== null) return { ...result, value: converted, units: def.units };
  }
  return result;
}

function evaluateRaw(node: EvalNode, name: string, seen: Set<string>): EvalResult {
  const def = findProp(node.props, name);
  const takeoffName = TAKEOFF_PROPS.find(t => t.toLowerCase() === name.trim().toLowerCase()) as keyof TakeoffValues;
  // Measured values of an element
  if (node.takeoff && takeoffName && (!def || def.takeoff)) {
    return { value: node.takeoff[takeoffName], units: def?.units ?? '' };
  }
  if (!def) {
    // Not defined here: a part still reaches its parent's value through [..]
    return { value: 0, units: '', error: `No property "${name}"` };
  }
  const guard = `${nodeId(node)}:${def.name.toLowerCase()}`;
  if (seen.has(guard)) return { value: 0, units: def.units, error: 'Circular formula' };
  seen.add(guard);
  try {
    const formula = def.formula.trim();
    if (formula === '') return { value: def.type === 'text' ? '' : 0, units: def.units };

    // JavaScript code
    if (isScriptFormula(formula)) {
      let error: string | undefined;
      const value = (r: EvalResult) => { if (r.error && !error) error = r.error; return r.value; };
      const result = runScript(scriptCode(formula), {
        ref: ref => value(reference(node, def, ref, seen)),
        parent: name => value(name === undefined ? reference(node, def, '..', seen)
          : node.parent ? evaluate(node.parent, String(name), seen) : { value: 0, units: '', error: 'No parent' }),
        parts: name => Number(value(reference(node, def, `Parts:${name}`, seen))) || 0,
      });
      if (typeof result === 'number') return { value: isFinite(result) ? result : 0, units: def.units, error };
      return { value: def.type === 'number' && result.trim() !== '' && isFinite(Number(result)) ? Number(result) : result, units: def.units, error };
    }

    // Exactly one reference: copies the value as is (text or number, and its units)
    const single = /^\[([^\]]*)\]$/.exec(formula);
    if (single) {
      const r = reference(node, def, single[1], seen);
      return { value: r.value, units: def.units || r.units, error: r.error };
    }
    if (def.type === 'text') return { value: formula, units: def.units };

    const tokens = tokenize(formula);
    if (!tokens) return { value: formula, units: def.units };          // plain text
    let error: string | undefined;
    const parser = new Parser(tokens, ref => {
      const r = reference(node, def, ref, seen);
      if (r.error && !error) error = r.error;
      return typeof r.value === 'number' ? r.value : Number(r.value) || 0;
    });
    const value = parser.parse();
    return { value: isFinite(value) ? value : 0, units: def.units, error };
  } catch (e) {
    return { value: 0, units: def.units, error: e instanceof Error ? e.message : 'Invalid formula' };
  } finally {
    seen.delete(guard);
  }
}

// [..] → same property on the parent; [Parts:Name] → sum over the parts below; [Name] → another property
function reference(node: EvalNode, def: PropertyDef, ref: string, seen: Set<string>): EvalResult {
  if (ref.trim() === '..') {
    if (!node.parent) return { value: 0, units: '', error: 'No parent for [..]' };
    return evaluate(node.parent, def.name, seen);
  }
  const sum = /^\s*parts\s*:(.+)$/i.exec(ref);
  if (sum) {
    let total = 0;
    for (const child of node.children?.() ?? []) {
      const r = evaluate(child, sum[1], seen);
      if (typeof r.value === 'number') total += r.value; else total += Number(r.value) || 0;
    }
    return { value: total, units: def.units };
  }
  return evaluate(node, ref, seen);
}

const nodeIds = new WeakMap<EvalNode, number>();
let nextNodeId = 1;
function nodeId(node: EvalNode): number {
  let id = nodeIds.get(node);
  if (!id) { id = nextNodeId++; nodeIds.set(node, id); }
  return id;
}

type Token = { type: 'num'; value: number } | { type: 'ref'; name: string } | { type: 'op'; op: string };

// null = not a formula (plain text such as "Part")
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end < 0) return null;
      tokens.push({ type: 'ref', name: text.slice(i + 1, end) });
      i = end + 1;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!match) return null;
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if ('+-*/()'.includes(ch)) {
      tokens.push({ type: 'op', op: ch });
      i++;
    } else if (ch === ',') {
      i++;                                   // thousands separator in "1,250"
    } else {
      return null;
    }
  }
  return tokens;
}

// Arithmetic with the usual precedence
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[], private readonly lookup: (name: string) => number) {}

  parse(): number {
    const value = this.sum();
    if (this.i < this.tokens.length) throw new Error('Invalid formula');
    return value;
  }

  private sum(): number {
    let value = this.product();
    for (let t = this.peek(); t?.type === 'op' && (t.op === '+' || t.op === '-'); t = this.peek()) {
      this.i++;
      value = t.op === '+' ? value + this.product() : value - this.product();
    }
    return value;
  }

  private product(): number {
    let value = this.unary();
    for (let t = this.peek(); t?.type === 'op' && (t.op === '*' || t.op === '/'); t = this.peek()) {
      this.i++;
      const right = this.unary();
      value = t.op === '*' ? value * right : right === 0 ? 0 : value / right;
    }
    return value;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.type === 'op' && (t.op === '-' || t.op === '+')) {
      this.i++;
      return t.op === '-' ? -this.unary() : this.unary();
    }
    return this.atom();
  }

  private atom(): number {
    const t = this.tokens[this.i++];
    if (!t) throw new Error('Invalid formula');
    if (t.type === 'num') return t.value;
    if (t.type === 'ref') return this.lookup(t.name);
    if (t.op === '(') {
      const value = this.sum();
      const close = this.tokens[this.i++];
      if (!close || close.type !== 'op' || close.op !== ')') throw new Error('Missing )');
      return value;
    }
    throw new Error('Invalid formula');
  }

  private peek(): Token | undefined { return this.tokens[this.i]; }
}

// "1,234.50" with the property's decimals
export function formatResult(result: EvalResult, decimals: number): string {
  if (typeof result.value === 'string') return result.value;
  return result.value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
