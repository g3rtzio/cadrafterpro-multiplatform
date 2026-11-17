// Basic types shared by the whole app (port of TakeoffModels.swift)

export interface Pt { x: number; y: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

export function rectFromPoints(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
export function rectContains(r: Rect, p: Pt, margin = 0): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin;
}
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}
// Smallest rectangle around every point
export function boundsOf(points: Pt[], margin = 0): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX - margin, y: minY - margin, w: maxX - minX + margin * 2, h: maxY - minY + margin * 2 };
}

let counter = 0;
export function uid(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Same colors SwiftUI uses on macOS
export const COLORS = {
  red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00', green: '#34C759', mint: '#00C7BE',
  cyan: '#32ADE6', blue: '#007AFF', indigo: '#5856D6', purple: '#AF52DE', pink: '#FF2D55',
  brown: '#A2845E', gray: '#8E8E93', black: '#000000', teal: '#30B0C7',
} as const;

// MARK: - Measurement type
export type TakeoffKind = 'count' | 'length' | 'segment' | 'area';
export const TAKEOFF_KINDS: TakeoffKind[] = ['area', 'length', 'segment', 'count'];

export function kindTitle(kind: TakeoffKind): string {
  switch (kind) {
    case 'count': return 'Count';
    case 'length': return 'Linear';
    case 'segment': return 'Segment';
    case 'area': return 'Area';
  }
}
export function kindUnit(kind: TakeoffKind): string {
  switch (kind) {
    case 'count': return 'ea';
    case 'length': case 'segment': return 'ft';
    case 'area': return 'sf';
  }
}
export function kindIcon(kind: TakeoffKind): string {
  switch (kind) {
    case 'count': return 'radio_button_checked';
    case 'length': return 'timeline';
    case 'segment': return 'horizontal_rule';
    case 'area': return 'pentagon';
  }
}

// Takeoff item (e.g. "Duplex Outlet")
export interface TakeoffItem {
  id: string;
  name: string;
  kind: TakeoffKind;
  color: string;           // "#RRGGBB"
  fillColor?: string;      // area fill (missing = same as the line)
  isVisible: boolean;
}

// MARK: - Scales. denominator = real size / paper size (1/4" = 1'-0" → 48)
export interface ScalePreset { name: string; denominator: number; }
export interface ScaleGroup { title: string; presets: ScalePreset[]; }

export const SCALE_GROUPS: ScaleGroup[] = [
  {
    title: 'Architectural', presets: [
      { name: '1/32" = 1\'-0"', denominator: 384 },
      { name: '1/16" = 1\'-0"', denominator: 192 },
      { name: '3/32" = 1\'-0"', denominator: 128 },
      { name: '1/8" = 1\'-0"', denominator: 96 },
      { name: '3/16" = 1\'-0"', denominator: 64 },
      { name: '1/4" = 1\'-0"', denominator: 48 },
      { name: '3/8" = 1\'-0"', denominator: 32 },
      { name: '1/2" = 1\'-0"', denominator: 24 },
      { name: '3/4" = 1\'-0"', denominator: 16 },
      { name: '1" = 1\'-0"', denominator: 12 },
      { name: '1 1/2" = 1\'-0"', denominator: 8 },
      { name: '3" = 1\'-0"', denominator: 4 },
    ],
  },
  {
    title: 'Engineering', presets: [
      { name: '1" = 10\'', denominator: 120 },
      { name: '1" = 20\'', denominator: 240 },
      { name: '1" = 30\'', denominator: 360 },
      { name: '1" = 40\'', denominator: 480 },
      { name: '1" = 50\'', denominator: 600 },
      { name: '1" = 60\'', denominator: 720 },
      { name: '1" = 100\'', denominator: 1200 },
    ],
  },
  {
    title: 'Metric', presets: [
      { name: '1:20', denominator: 20 },
      { name: '1:50', denominator: 50 },
      { name: '1:75', denominator: 75 },
      { name: '1:100', denominator: 100 },
      { name: '1:125', denominator: 125 },
      { name: '1:200', denominator: 200 },
    ],
  },
];

const ALL_PRESETS = SCALE_GROUPS.flatMap(g => g.presets);

// "1/4\" = 1'-0\"", or "1 in = 8.333 ft" if it isn't in the list
export function scaleName(denominator: number): string {
  const preset = ALL_PRESETS.find(p => p.denominator === denominator);
  if (preset) return preset.name;
  const feet = denominator / 12;
  return `1 in = ${formatNumber(feet)} ft`;
}
export function isPresetScale(denominator: number): boolean {
  return ALL_PRESETS.some(p => p.denominator === denominator);
}
// Architectural scales are written by Revu as "0.25 in = 1 ft"
export function isArchitecturalScale(denominator: number): boolean {
  return SCALE_GROUPS[0].presets.some(p => p.denominator === denominator);
}
// Whole numbers without decimals, others with up to 4 significant digits
export function formatNumber(v: number): string {
  return v === Math.round(v) ? v.toFixed(0) : String(Number(v.toPrecision(4)));
}

// Units for a custom scale ("1 in = 8.333 ft")
export type ScaleUnit = 'in' | 'ft' | 'mm' | 'cm' | 'm';
export const SCALE_UNITS: ScaleUnit[] = ['in', 'ft', 'mm', 'cm', 'm'];
const SCALE_UNIT_INCHES: Record<ScaleUnit, number> = { in: 1, ft: 12, mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254 };

// Scale denominator for "paper paperUnit = real realUnit"
export function denominatorFor(paper: number, paperUnit: ScaleUnit, real: number, realUnit: ScaleUnit): number | null {
  const d = (real * SCALE_UNIT_INCHES[realUnit]) / (paper * SCALE_UNIT_INCHES[paperUnit]);
  if (!isFinite(d) || d <= 0) return null;
  return Math.round(d * 10_000) / 10_000;
}

// A part of a page with its own scale (Revu "Viewport"), for example a detail at 1/2" = 1'-0"
export interface ScaleViewport {
  id: string;
  name: string;
  pageIndex: number;
  rect: Rect;              // in page coordinates
  denominator: number;
}

// MARK: - How a length is shown in the caption and in Properties (the estimate stays in ft / sf)
export type LengthUnit = 'ft\' in"' | 'ft' | 'in' | 'yd' | 'mi' | 'mm' | 'cm' | 'm' | 'km';
export const LENGTH_UNITS: LengthUnit[] = ['ft\' in"', 'ft', 'in', 'yd', 'mi', 'mm', 'cm', 'm', 'km'];

// How many of this unit are in one foot
const PER_FOOT: Record<LengthUnit, number> = {
  'ft\' in"': 1, ft: 1, in: 12, yd: 1 / 3, mi: 1 / 5280, mm: 304.8, cm: 30.48, m: 0.3048, km: 0.0003048,
};
const AREA_UNIT: Record<LengthUnit, string> = {
  'ft\' in"': 'sf', ft: 'sf', in: 'sq in', yd: 'sy', mi: 'sq mi', mm: 'mm²', cm: 'cm²', m: 'm²', km: 'km²',
};

// Units an area can be shown in (each is the square of a length unit; feet-and-inches areas are SF)
export const AREA_UNITS: LengthUnit[] = ['ft', 'in', 'yd', 'mi', 'mm', 'cm', 'm', 'km'];
const AREA_UNIT_NAME: Record<LengthUnit, string> = {
  'ft\' in"': 'Square feet (sf)', ft: 'Square feet (sf)', in: 'Square inches (sq in)', yd: 'Square yards (sy)',
  mi: 'Square miles (sq mi)', mm: 'Square millimeters (mm²)', cm: 'Square centimeters (cm²)', m: 'Square meters (m²)',
  km: 'Square kilometers (km²)',
};
export function areaUnitName(unit: LengthUnit): string { return AREA_UNIT_NAME[unit]; }
const LENGTH_UNIT_NAME: Record<LengthUnit, string> = {
  'ft\' in"': 'Feet and inches (ft\' in")', ft: 'Feet (ft)', in: 'Inches (in)', yd: 'Yards (yd)', mi: 'Miles (mi)',
  mm: 'Millimeters (mm)', cm: 'Centimeters (cm)', m: 'Meters (m)', km: 'Kilometers (km)',
};
export function lengthUnitName(unit: LengthUnit): string { return LENGTH_UNIT_NAME[unit]; }

// "24'-9 1/4\"", "8.50 ft", "2.59 m"
export function lengthText(unit: LengthUnit, feet: number): string {
  if (unit !== 'ft\' in"') return `${(feet * PER_FOOT[unit]).toFixed(2)} ${unit}`;
  const quarters = Math.round(Math.abs(feet) * 48);       // whole 1/4 inches
  const ft = Math.floor(quarters / 48);
  const inches = Math.floor((quarters % 48) / 4);
  const fraction = ['', ' 1/4', ' 1/2', ' 3/4'][quarters % 4];
  return `${feet < 0 ? '-' : ''}${ft}'-${inches}${fraction}"`;
}
// "340.00 sf", "31.59 m²"
export function areaText(unit: LengthUnit, squareFeet: number): string {
  return `${(squareFeet * PER_FOOT[unit] * PER_FOOT[unit]).toFixed(2)} ${AREA_UNIT[unit]}`;
}

// "7 ea", "24'-9 1/4\"", "8.50 ft", "340.00 sf" (value in ft / sf)
export function quantityText(value: number, kind: TakeoffKind, unit: LengthUnit): string {
  switch (kind) {
    case 'count': return `${value.toFixed(0)} ea`;
    case 'length': case 'segment': return lengthText(unit, value);
    case 'area': return areaText(unit, value);
  }
}

// MARK: - Line style of a measurement
export type LineStyle = 'Solid' | 'Dashed' | 'Dotted';
export const LINE_STYLES: LineStyle[] = ['Solid', 'Dashed', 'Dotted'];

// Dash pattern for a line of this width (empty = solid)
export function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'Solid': return [];
    case 'Dashed': return [6 * width, 4 * width];
    case 'Dotted': return [0.01, 3 * width];             // with round caps → dots
  }
}

// MARK: - Geometry used by quantities
export function polylineLength(p: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < p.length; i++) sum += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return sum;
}
export function polygonArea(p: Pt[]): number {
  if (p.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}
