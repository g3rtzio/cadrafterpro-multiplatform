// Filters of the estimate table (PlanSwift's "Filter builder" and the filter row under the headers).
// A filter is a tree: groups join their conditions with AND / OR (or NOT AND / NOT OR), and a
// condition compares one field of a row (a property such as "Qty", or Name, Type, Pages…) with a value.

export type FilterOp =
  | 'equals' | 'does not equal' | 'contains' | 'does not contain' | 'begins with' | 'ends with'
  | 'is greater than' | 'is greater or equal' | 'is less than' | 'is less or equal' | 'is blank' | 'is not blank';

export const FILTER_OPS: FilterOp[] = [
  'equals', 'does not equal', 'contains', 'does not contain', 'begins with', 'ends with',
  'is greater than', 'is greater or equal', 'is less than', 'is less or equal', 'is blank', 'is not blank',
];

export type FilterLogic = 'AND' | 'OR' | 'NOT AND' | 'NOT OR';
export const FILTER_LOGICS: FilterLogic[] = ['AND', 'OR', 'NOT AND', 'NOT OR'];

export interface FilterCondition { kind: 'condition'; id: string; field: string; op: FilterOp; value: string; }
export interface FilterGroup { kind: 'group'; id: string; logic: FilterLogic; items: FilterNode[]; }
export type FilterNode = FilterCondition | FilterGroup;

// Fields every row has besides its properties
export const FILTER_SPECIAL_FIELDS = ['IsTakeoffItem', 'IsPart', 'Name', 'Type', 'Pages', 'Color'];

export function newFilterId(): string {
  return `f-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyFilter(): FilterGroup {
  return { kind: 'group', id: newFilterId(), logic: 'AND', items: [] };
}

export function newCondition(field = 'IsTakeoffItem'): FilterCondition {
  return { kind: 'condition', id: newFilterId(), field, op: 'equals', value: field === 'IsTakeoffItem' ? 'True' : '' };
}

// Number when the text is one ("1,250.50" too)
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (text === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  return Number(text);
}

export function compare(actual: unknown, op: FilterOp, expected: string): boolean {
  const text = String(actual ?? '').trim();
  const lower = text.toLowerCase(), want = expected.trim().toLowerCase();
  const a = asNumber(actual), b = asNumber(expected);
  switch (op) {
    case 'is blank': return text === '';
    case 'is not blank': return text !== '';
    case 'equals': return a !== null && b !== null ? Math.abs(a - b) < 1e-9 : lower === want;
    case 'does not equal': return !compare(actual, 'equals', expected);
    case 'contains': return lower.includes(want);
    case 'does not contain': return !lower.includes(want);
    case 'begins with': return lower.startsWith(want);
    case 'ends with': return lower.endsWith(want);
  }
  if (a === null || b === null) {
    // Text compared alphabetically
    const c = lower.localeCompare(want);
    return op === 'is greater than' ? c > 0 : op === 'is greater or equal' ? c >= 0 : op === 'is less than' ? c < 0 : c <= 0;
  }
  return op === 'is greater than' ? a > b : op === 'is greater or equal' ? a >= b : op === 'is less than' ? a < b : a <= b;
}

// Does a row pass the filter? `value` reads one field of the row. An empty group lets everything pass.
export function matchesFilter(node: FilterNode, value: (field: string) => unknown): boolean {
  if (node.kind === 'condition') return !node.field || compare(value(node.field), node.op, node.value);
  if (node.items.length === 0) return true;
  const results = node.items.map(item => matchesFilter(item, value));
  const any = node.logic === 'OR' || node.logic === 'NOT OR';
  const result = any ? results.some(Boolean) : results.every(Boolean);
  return node.logic.startsWith('NOT') ? !result : result;
}

export function isFilterEmpty(node: FilterGroup | null): boolean {
  return !node || node.items.length === 0;
}

// Text of the filter row under a header: "concrete" (contains), "> 10", ">= 5", "< 3", "= 0", "<> 2", "!= 2"
export function matchesColumnText(actual: unknown, filter: string): boolean {
  const f = filter.trim();
  if (!f) return true;
  const m = /^(>=|<=|<>|!=|>|<|=)\s*(.*)$/.exec(f);
  if (!m) return compare(actual, 'contains', f);
  const op: FilterOp = { '>=': 'is greater or equal', '<=': 'is less or equal', '<>': 'does not equal', '!=': 'does not equal',
    '>': 'is greater than', '<': 'is less than', '=': 'equals' }[m[1]] as FilterOp;
  return compare(actual, op, m[2]);
}

// Readable summary: "IsTakeoffItem equals True AND Qty is greater than 10"
export function filterText(node: FilterNode): string {
  if (node.kind === 'condition') {
    return node.op === 'is blank' || node.op === 'is not blank' ? `${node.field} ${node.op}` : `${node.field} ${node.op} ${node.value}`;
  }
  const inner = node.items.map(i => i.kind === 'group' ? `(${filterText(i)})` : filterText(i)).join(` ${node.logic.replace('NOT ', '')} `);
  return node.logic.startsWith('NOT') ? `NOT (${inner})` : inner;
}

// A filter read from a .flt file (JSON), checked
export function parseFilter(text: string): FilterGroup | null {
  try {
    const data = JSON.parse(text) as unknown;
    const clean = (n: unknown): FilterNode | null => {
      if (!n || typeof n !== 'object') return null;
      const o = n as Record<string, unknown>;
      if (o['kind'] === 'condition') {
        const op = FILTER_OPS.includes(o['op'] as FilterOp) ? o['op'] as FilterOp : 'equals';
        return { kind: 'condition', id: newFilterId(), field: String(o['field'] ?? ''), op, value: String(o['value'] ?? '') };
      }
      if (o['kind'] === 'group') {
        const logic = FILTER_LOGICS.includes(o['logic'] as FilterLogic) ? o['logic'] as FilterLogic : 'AND';
        const items = Array.isArray(o['items']) ? o['items'].map(clean).filter((x): x is FilterNode => !!x) : [];
        return { kind: 'group', id: newFilterId(), logic, items };
      }
      return null;
    };
    const root = clean(data);
    return root?.kind === 'group' ? root : null;
  } catch {
    return null;
  }
}
