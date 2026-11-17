// Units of measure for the Input Units / Output Units of a property. A result is calculated in
// its input units and shown converted to its output units when both are known and measure the
// same thing (length, area, volume, weight, time or count): 27 CF → 1 CY, 9 SF → 1 SY.
// Units that aren't in the list ("$", "%", "LS", anything typed by hand) are shown as they are.

export type UnitDimension = 'Length' | 'Area' | 'Volume' | 'Weight' | 'Time' | 'Count' | 'Other';

export interface UnitInfo {
  code: string;
  name: string;
  dimension: UnitDimension;
  factor: number;               // size in the base unit of its dimension (FT, SF, CF, LB, HR, EA)
}

const u = (code: string, name: string, dimension: UnitDimension, factor = 1): UnitInfo => ({ code, name, dimension, factor });

export const UNITS: UnitInfo[] = [
  // Length (base: feet)
  u('IN', 'Inches', 'Length', 1 / 12), u('FT', 'Feet', 'Length'), u('LF', 'Linear Feet', 'Length'),
  u('YD', 'Yards', 'Length', 3), u('MI', 'Miles', 'Length', 5280),
  u('MM', 'Millimeters', 'Length', 1 / 304.8), u('CM', 'Centimeters', 'Length', 1 / 30.48),
  u('M', 'Meters', 'Length', 1 / 0.3048), u('KM', 'Kilometers', 'Length', 1000 / 0.3048),
  // Area (base: square feet)
  u('SQIN', 'Square Inches', 'Area', 1 / 144), u('SF', 'Square Feet', 'Area'), u('SY', 'Square Yards', 'Area', 9),
  u('SQ', 'Squares (100 SF)', 'Area', 100), u('MSF', 'Thousand Square Feet', 'Area', 1000),
  u('ACRE', 'Acres', 'Area', 43560), u('CM2', 'Square Centimeters', 'Area', 1 / 929.0304),
  u('M2', 'Square Meters', 'Area', 1 / 0.09290304), u('HA', 'Hectares', 'Area', 10000 / 0.09290304),
  // Volume (base: cubic feet)
  u('CI', 'Cubic Inches', 'Volume', 1 / 1728), u('CF', 'Cubic Feet', 'Volume'), u('CY', 'Cubic Yards', 'Volume', 27),
  u('BF', 'Board Feet', 'Volume', 1 / 12), u('MBF', 'Thousand Board Feet', 'Volume', 1000 / 12),
  u('GAL', 'Gallons (US)', 'Volume', 0.133680556), u('QT', 'Quarts (US)', 'Volume', 0.033420139),
  u('ML', 'Milliliters', 'Volume', 1 / 28316.846592), u('L', 'Liters', 'Volume', 1 / 28.316846592),
  u('M3', 'Cubic Meters', 'Volume', 1 / 0.028316846592),
  // Weight (base: pounds)
  u('OZ', 'Ounces', 'Weight', 1 / 16), u('LB', 'Pounds', 'Weight'), u('TON', 'Tons (2,000 LB)', 'Weight', 2000),
  u('G', 'Grams', 'Weight', 1 / 453.59237), u('KG', 'Kilograms', 'Weight', 1 / 0.45359237),
  u('MT', 'Metric Tons', 'Weight', 1000 / 0.45359237),
  // Time (base: hours)
  u('SEC', 'Seconds', 'Time', 1 / 3600), u('MIN', 'Minutes', 'Time', 1 / 60), u('HR', 'Hours', 'Time'),
  u('DAY', 'Days (24 HR)', 'Time', 24), u('WK', 'Weeks', 'Time', 168), u('MO', 'Months', 'Time', 730),
  u('YR', 'Years', 'Time', 8760),
  // Count (base: each)
  u('EA', 'Each', 'Count'), u('PR', 'Pairs', 'Count', 2), u('DZ', 'Dozens', 'Count', 12), u('GR', 'Gross (144)', 'Count', 144),
  // Not converted
  u('$', 'Dollars', 'Other'), u('%', 'Percent', 'Other'), u('LS', 'Lump Sum', 'Other'),
];

// Other ways of writing the same units
const ALIASES: Record<string, string> = {
  '"': 'IN', INCH: 'IN', INCHES: 'IN', "'": 'FT', FOOT: 'FT', FEET: 'FT', LNFT: 'LF', LINFT: 'LF', LFT: 'LF',
  YARD: 'YD', YARDS: 'YD', METER: 'M', METERS: 'M', METRE: 'M', METRES: 'M',
  SQFT: 'SF', FT2: 'SF', SFT: 'SF', SQYD: 'SY', YD2: 'SY', IN2: 'SQIN', SM: 'M2', SQM: 'M2', ACRES: 'ACRE', AC: 'ACRE',
  CUFT: 'CF', FT3: 'CF', CUYD: 'CY', YD3: 'CY', IN3: 'CI', CUIN: 'CI', CM3: 'ML', CC: 'ML', CUM: 'M3',
  GALLON: 'GAL', GALLONS: 'GAL', LITER: 'L', LITERS: 'L', LITRE: 'L', LT: 'L', FBM: 'BF',
  LBS: 'LB', POUND: 'LB', POUNDS: 'LB', TONS: 'TON', KGS: 'KG', TONNE: 'MT', TONNES: 'MT',
  H: 'HR', HRS: 'HR', HOUR: 'HR', HOURS: 'HR', MINS: 'MIN', MINUTE: 'MIN', MINUTES: 'MIN', S: 'SEC',
  DAYS: 'DAY', D: 'DAY', WEEK: 'WK', WEEKS: 'WK', WKS: 'WK', MONTH: 'MO', MONTHS: 'MO', YEAR: 'YR', YEARS: 'YR',
  EACH: 'EA', PC: 'EA', PCS: 'EA', PIECES: 'EA', PAIR: 'PR', PAIRS: 'PR', DOZ: 'DZ',
};

const byCode = new Map(UNITS.map(unit => [unit.code, unit]));

// "sq ft", "ft²", "M2" → the unit, or undefined for units typed by hand that aren't in the list
export function findUnit(text: string | null | undefined): UnitInfo | undefined {
  if (!text) return undefined;
  const key = text.trim().toUpperCase().replace(/²/g, '2').replace(/³/g, '3').replace(/[\s.]/g, '');
  if (!key) return undefined;
  return byCode.get(key) ?? byCode.get(ALIASES[key] ?? '');
}

// value in `from` → value in `to`; null when they can't be converted (unknown or different dimension)
export function convertUnits(value: number, from: string, to: string): number | null {
  const a = findUnit(from);
  const b = findUnit(to);
  if (!a || !b || a.dimension !== b.dimension || a.dimension === 'Other') return null;
  if (a.factor === b.factor) return value;
  return value * a.factor / b.factor;
}

// Units for the drop-down list: "SF - Square Feet", by dimension
export function unitOptions(): { value: string; label: string }[] {
  return UNITS.map(unit => ({ value: unit.code, label: `${unit.name} (${unit.dimension})` }));
}
