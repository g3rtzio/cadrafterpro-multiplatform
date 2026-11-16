import type { PDFRef } from 'pdf-lib';
import {
  COLORS, LengthUnit, LineStyle, Pt, Rect, TakeoffKind, boundsOf, uid,
} from './takeoff';

// App measurement, saved as a Bluebeam Revu markup (port of MeasurementAnnotation.swift):
// Count   → /Polygon  /IT /PolygonCount      (one circle per click, like Revu)
// Linear  → /PolyLine /IT /PolyLineDimension
// Segment → /PolyLine /IT /PolyLineDimension (2 points)
// Area    → /Polygon  /IT /PolygonDimension
export class Measurement {
  static readonly countRadius = 4.5;       // count circle size (like Revu)

  readonly id = uid();
  readonly isMeasurement = true;
  points: Pt[] = [];                       // in page coordinates (PDF points, y up)
  name = '';                               // item name (Revu "Subject")
  contents = '';                           // quantity text ("12.50 ft")
  visible = true;
  nm = randomName();                       // Revu /NM
  createdAt = new Date();
  pdfRef: PDFRef | null = null;            // object written by the last save (replaced on the next one)

  // MARK: - Appearance (Properties panel › Appearance)
  lineColor: string = COLORS.blue;
  opacity = 1;                             // whole markup (line and fill)
  fillOpacity = 0.2;                       // area fill
  fillColor: string | null = null;         // area fill color (null = same as the line)
  lineWidth = 1.5;                         // in PDF points (it grows with the zoom)
  lineStyle: LineStyle = 'Solid';
  showCaption: boolean;                    // measurement text on the plan
  captionFontName = 'System';
  captionFontSize = 12;                    // in PDF points (it grows with the zoom)
  captionColor: string | null = null;      // null = same as the line
  captionBold = false;
  captionItalic = false;
  lengthUnit: LengthUnit = 'ft';           // unit of the caption ("8.50 ft", "8'-6\"")
  arrowEnds = false;                       // arrows on both ends (Dimension)

  constructor(public readonly kind: TakeoffKind, public pageIndex: number, public itemId: string) {
    this.showCaption = kind !== 'count';   // a "1" next to every count is just noise
  }

  get color(): string { return this.lineColor; }

  // Color the area is filled with (Revu /IC)
  get areaFillColor(): string { return this.fillColor ?? this.lineColor; }

  // The rectangle that wraps every point
  get bounds(): Rect {
    return boundsOf(this.points, this.kind === 'count' ? Measurement.countRadius + 4 : 6);
  }

  move(dx: number, dy: number): void {
    this.points = this.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  }

  // MARK: - Caption (text with the measurement)
  get captionTextColor(): string { return this.captionColor ?? this.lineColor; }

  // Where the caption goes (page coordinates): center of an area,
  // middle of a line, or to the right of a count
  get captionAnchor(): Pt | null {
    const pts = this.points;
    if (pts.length === 0) return null;
    switch (this.kind) {
      case 'count':
        return { x: pts[0].x + Measurement.countRadius * 3, y: pts[0].y };
      case 'area': {
        const sum = pts.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
        return { x: sum.x / pts.length, y: sum.y / pts.length };
      }
      case 'length': case 'segment':
        return pointAtHalfLength(pts);
    }
  }

  // Both arrowheads of a line (empty when it has no arrows)
  arrowHeads(pts: Pt[], length: number): Pt[][] {
    if (!this.arrowEnds || (this.kind !== 'length' && this.kind !== 'segment') || pts.length < 2) return [];
    return [arrowHead(pts[1], pts[0], length), arrowHead(pts[pts.length - 2], pts[pts.length - 1], length)];
  }

  // Font and color in the CSS-like text Revu keeps in /DS
  get revuTextStyle(): string {
    const family = this.captionFontName === 'System' ? 'Helvetica' : this.captionFontName;
    let style = `font: ${family} ${Math.round(this.captionFontSize)}pt; text-align:center; color:${this.captionTextColor.toUpperCase()}`;
    if (this.captionBold) style += '; font-weight:bold';
    if (this.captionItalic) style += '; font-style:italic';
    return style;
  }
}

// PDF markup that was already in the file (Revu or any other app).
// The app shows it, selects it, moves it, renames it and hides it; on save those
// changes are written back into its own PDF dictionary.
export class Markup {
  readonly id = uid();
  readonly isMeasurement = false;
  ref: PDFRef | null = null;               // its object in the opened file (null = new copy)
  template: Markup | null = null;          // a copy made by "continue" is cloned from this one
  dirty = false;                           // changed in the app: rewrite it when saving

  subtype = 'Annotation';                  // "Polygon", "PolyLine", "Square", "Ink"...
  intent = '';                             // Revu /IT ("PolygonCount", "PolyLineDimension"...)
  subject = '';                            // Revu "Subject" (/Subj)
  contents = '';                           // /Contents ("154.09 sf")
  color: string | null = null;             // /C
  fillColor: string | null = null;         // /IC
  opacity = 1;                             // /CA
  fillOpacity: number | null = null;       // Revu /FillOpacity
  lineWidth = 1;                           // /BS /W
  dashed = false;
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 }; // /Rect
  vertices: Pt[] | null = null;            // /Vertices (Polygon, PolyLine)
  line: Pt[] | null = null;                // /L (Line)
  inkList: Pt[][] | null = null;           // /InkList (Ink: Revu Pen and Highlight)
  multiply = false;                        // /BM /Multiply (Revu Highlight)
  visible = true;                          // /F without the "hidden" bit
  // Image markups (Snapshot pasted in the app, or a JPEG stamp already in the file)
  imageUrl: string | null = null;          // what the plan shows (data URL)
  imageJpeg: Uint8Array | null = null;     // new snapshot: the JPEG written into the PDF on save
  imageMatrix: number[] | null = null;     // picture's unit square → page coordinates (set when saving)

  // MARK: - Markups drawn with the Markup tools (text box, callout, cloud, shapes, pen)
  appMade = false;                         // made by CadrafterPro: the whole dictionary and /AP are rewritten on save
  nm = randomName();                       // /NM (Revu id)
  author = '';                             // /T
  cloud = 0;                               // /BE /S /C intensity (0 = straight edges)
  callout: Pt[] | null = null;             // /CL: arrow tip, knee and the point on the text box
  textBox: Rect | null = null;             // text area of a FreeText (/Rect minus /RD); null = the whole /Rect
  lineEnds: string[] | null = null;        // /LE: line endings ("None", "OpenArrow", "ClosedArrow")
  fontSize = 12;                           // FreeText font size (from /DA or /DS)
  textColor: string | null = null;         // FreeText text color (null = black)
  quads: Rect[] | null = null;             // /QuadPoints of text markups (highlight, underline, redaction, link)
  uri: string | null = null;               // Link: web address (/A /URI)
  destPage: number | null = null;          // Link: page it jumps to (0-based)

  constructor(public pageIndex: number) {}

  get typeName(): string { return this.subtype; }

  // Name: the Bluebeam "Subject" or, if it has none, the type
  get name(): string { return this.subject || this.subtype; }
  set name(value: string) { this.subject = value; this.dirty = true; }

  get bounds(): Rect { return this.rect; }

  // Markup type shown in the estimate ("Highlight", "Cloud", "Callout"…); null for Revu measurements,
  // which are areas, lengths or counts
  get markupType(): string | null {
    if (this.isRevuMeasurement) return null;
    const known = ['Cloud+', 'Cloud', 'Callout', 'Text Box', 'Snapshot', 'Arrow', 'Highlight', 'Pen', 'Rectangle',
      'Ellipse', 'Line', 'Polyline', 'Polygon', 'Underline', 'Squiggly', 'Strikethrough', 'Redaction', 'Hyperlink'];
    const subject = known.find(k => k.toLowerCase() === this.subject.trim().toLowerCase());
    if (subject) return subject;
    switch (this.subtype) {
      case 'FreeText':
        if (/callout/i.test(this.intent) || this.callout) return 'Callout';
        return /typewriter/i.test(this.intent) ? 'Typewriter' : 'Text Box';
      case 'Polygon': return this.cloud > 0 || /cloud/i.test(this.intent) ? 'Cloud' : 'Polygon';
      case 'PolyLine': return 'Polyline';
      case 'Line': return this.lineEnds?.some(e => e !== 'None') ? 'Arrow' : 'Line';
      case 'Square': return 'Rectangle';
      case 'Circle': return 'Ellipse';
      case 'Ink': return this.isHighlight ? 'Highlight' : 'Pen';
      case 'Stamp': return this.imageUrl || /snapshot/i.test(this.subject) ? 'Snapshot' : 'Stamp';
      case 'StrikeOut': return 'Strikethrough';
      case 'Redact': return 'Redaction';
      case 'Link': return 'Hyperlink';
      case 'Text': return 'Note';
      case 'Annotation': return null;
      default: return this.subtype;
    }
  }

  // Text area of a text box or a callout
  get textRect(): Rect { return this.textBox ?? this.rect; }

  get isTextBox(): boolean { return this.subtype === 'FreeText'; }

  // Size of the scallops of a cloud, in PDF points
  get cloudSize(): number { return 12 * Math.max(this.cloud, 0.5) + this.lineWidth; }

  // Recomputes /Rect from the geometry (after drawing, moving the text or resizing a text box)
  updateRect(): void {
    const pad = Math.max(this.lineWidth, 1) * 2 + 2;
    switch (this.subtype) {
      case 'FreeText': {
        const box = this.textRect;
        if (!this.callout) { this.rect = { ...box }; break; }
        // A callout's /Rect wraps the text box, the leader line and its arrowhead
        const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }];
        this.rect = boundsOf([...corners, ...this.callout], pad + this.arrowSize);
        break;
      }
      case 'Polygon': case 'PolyLine':
        if (this.vertices) this.rect = boundsOf(this.vertices, this.cloud ? this.cloudSize + pad : pad + this.arrowSize);
        break;
      case 'Line':
        if (this.line) this.rect = boundsOf(this.line, pad + this.arrowSize);
        break;
      case 'Ink':
        if (this.inkList) this.rect = boundsOf(this.inkList.flat(), this.lineWidth / 2 + 2);
        break;
      default:
        // Text markups: the box around every marked piece of text
        if (this.quads?.length) {
          this.rect = boundsOf(this.quads.flatMap(q => [{ x: q.x, y: q.y }, { x: q.x + q.w, y: q.y + q.h }]), 1);
        }
        break;
    }
  }

  // Length of the arrowheads (line endings)
  get arrowSize(): number { return Math.max(this.lineWidth * 5, 8); }

  // Can be selected on the plan and listed in the tree
  get isPlanElement(): boolean {
    // Links made from search results are shown (and can be deleted); other links stay hidden
    if (this.subtype === 'Link') return this.appMade;
    const notElements = ['Widget', 'Popup'];
    return !notElements.includes(this.subtype);
  }

  get isHighlight(): boolean {
    return this.subtype === 'Ink' && (this.multiply || this.name.toLowerCase().includes('highlight'));
  }

  // Revu measurement markups show their value next to the shape
  get isRevuMeasurement(): boolean {
    return /Dimension|Count/.test(this.intent);
  }

  move(dx: number, dy: number): void {
    const shift = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
    this.rect = { ...this.rect, x: this.rect.x + dx, y: this.rect.y + dy };
    if (this.vertices) this.vertices = this.vertices.map(shift);
    if (this.line) this.line = this.line.map(shift);
    if (this.inkList) this.inkList = this.inkList.map(path => path.map(shift));
    if (this.callout) this.callout = this.callout.map(shift);
    if (this.textBox) this.textBox = { ...this.textBox, x: this.textBox.x + dx, y: this.textBox.y + dy };
    if (this.quads) this.quads = this.quads.map(q => ({ ...q, x: q.x + dx, y: q.y + dy }));
    this.dirty = true;
  }

  // New markup with the same look, centered on `center` (green dot on a PDF group)
  copy(center: Pt): Markup {
    const m = Object.assign(new Markup(this.pageIndex), this, {
      id: uid(), ref: null, template: this.template ?? this, dirty: true, visible: true,
    }) as Markup;
    const dx = center.x - (this.rect.x + this.rect.w / 2);
    const dy = center.y - (this.rect.y + this.rect.h / 2);
    m.rect = { ...this.rect };
    m.vertices = this.vertices && this.vertices.map(p => ({ ...p }));
    m.line = this.line && this.line.map(p => ({ ...p }));
    m.inkList = this.inkList && this.inkList.map(path => path.map(p => ({ ...p })));
    m.callout = this.callout && this.callout.map(p => ({ ...p }));
    m.textBox = this.textBox && { ...this.textBox };
    m.quads = this.quads && this.quads.map(q => ({ ...q }));
    m.nm = randomName();
    m.move(dx, dy);
    return m;
  }
}

export type PlanElement = Measurement | Markup;

// Arrowhead at `tip`, pointing away from `from`: the tip and its two back corners
export function arrowHead(from: Pt, tip: Pt, length: number): Pt[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 7;
  return [
    tip,
    { x: tip.x - length * Math.cos(angle - spread), y: tip.y - length * Math.sin(angle - spread) },
    { x: tip.x - length * Math.cos(angle + spread), y: tip.y - length * Math.sin(angle + spread) },
  ];
}

// Direction of the segment in the middle of a polyline, in radians, turned so text along it
// reads left to right (never upside down)
export function readableAngleAtHalfLength(pts: Pt[], yDown: boolean): number {
  if (pts.length < 2) return 0;
  const lengths = pts.slice(1).map((b, i) => Math.hypot(b.x - pts[i].x, b.y - pts[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  let i = 0;
  while (i < lengths.length - 1 && remaining > lengths[i]) { remaining -= lengths[i]; i++; }
  const a = pts[i], b = pts[i + 1];
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  // Keep it within ±90°; a vertical line reads bottom to top (like the dimensions on drawings)
  const limit = Math.PI / 2 - 1e-6;
  if (angle > limit) angle -= Math.PI;
  if (angle < -limit) angle += Math.PI;
  if (Math.abs(Math.abs(angle) - Math.PI / 2) < 1e-3) angle = yDown ? -Math.PI / 2 : Math.PI / 2;
  return angle;
}

// Walks half of the total length along a polyline
export function pointAtHalfLength(pts: Pt[]): Pt {
  if (pts.length < 2) return pts[0];
  const lengths = pts.slice(1).map((b, i) => Math.hypot(b.x - pts[i].x, b.y - pts[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (remaining <= l && l > 0) {
      const a = pts[i], b = pts[i + 1], t = remaining / l;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= l;
  }
  return pts[pts.length - 1];
}

// Revu names its markups and viewports with 16 capital letters
export function randomName(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 16 }, () => letters[Math.floor(Math.random() * 26)]).join('');
}

// MARK: - Shared geometry of the Markup tools (used by the SVG layer and by the PDF appearance)

// One cubic Bézier piece: two control points and the end point
export type Cubic = [Pt, Pt, Pt];

// Revu-style cloud along a closed polygon: one half circle (two cubic pieces) per scallop,
// always bulging outwards. Returns the start point and the pieces, in the polygon's coordinates.
export function cloudCurves(vertices: Pt[], scallop: number): { start: Pt; curves: Cubic[] } | null {
  if (vertices.length < 3) return null;
  // Winding: the outward side of each edge depends on it
  let twice = 0;
  vertices.forEach((p, i) => {
    const q = vertices[(i + 1) % vertices.length];
    twice += p.x * q.y - q.x * p.y;
  });
  const sign = twice >= 0 ? 1 : -1;
  const curves: Cubic[] = [];
  const k = 0.5523;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const n = Math.max(1, Math.round(length / scallop));
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const out = { x: u.y * sign, y: -u.x * sign };        // outward normal
    const r = length / n / 2;
    for (let j = 0; j < n; j++) {
      const p = { x: a.x + u.x * r * 2 * j, y: a.y + u.y * r * 2 * j };
      const q = { x: p.x + u.x * r * 2, y: p.y + u.y * r * 2 };
      const top = { x: p.x + u.x * r + out.x * r, y: p.y + u.y * r + out.y * r };
      curves.push([
        { x: p.x + out.x * r * k, y: p.y + out.y * r * k },
        { x: top.x - u.x * r * k, y: top.y - u.y * r * k },
        top,
      ]);
      curves.push([
        { x: top.x + u.x * r * k, y: top.y + u.y * r * k },
        { x: q.x + out.x * r * k, y: q.y + out.y * r * k },
        q,
      ]);
    }
  }
  return { start: vertices[0], curves };
}

// Bézier pieces of an ellipse inside a rectangle (four quarter arcs)
export function ellipseCurves(r: Rect): { start: Pt; curves: Cubic[] } {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2, ry = r.h / 2, k = 0.5523;
  return {
    start: { x: cx + rx, y: cy },
    curves: [
      [{ x: cx + rx, y: cy + ry * k }, { x: cx + rx * k, y: cy + ry }, { x: cx, y: cy + ry }],
      [{ x: cx - rx * k, y: cy + ry }, { x: cx - rx, y: cy + ry * k }, { x: cx - rx, y: cy }],
      [{ x: cx - rx, y: cy - ry * k }, { x: cx - rx * k, y: cy - ry }, { x: cx, y: cy - ry }],
      [{ x: cx + rx * k, y: cy - ry }, { x: cx + rx, y: cy - ry * k }, { x: cx + rx, y: cy }],
    ],
  };
}

// Line ending at `tip` (coming from `from`): the points to draw.
// Open arrows are a polyline (two strokes), closed arrows a filled triangle.
export function lineEnding(style: string, from: Pt, tip: Pt, length: number): { points: Pt[]; closed: boolean } | null {
  if (!style || style === 'None') return null;
  if (Math.hypot(tip.x - from.x, tip.y - from.y) < 1e-6) return null;
  const [t, left, right] = arrowHead(from, tip, length);
  switch (style) {
    case 'OpenArrow': return { points: [left, t, right], closed: false };
    case 'ClosedArrow': return { points: [t, left, right], closed: true };
    default: return { points: [left, t, right], closed: false };
  }
}

// Splits a text into lines that fit `width` (by words; very long words are cut)
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.split(/(\s+)/).filter(w => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && measure(candidate.trimEnd()) > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
      // A single word wider than the box: cut it
      while (measure(line) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Padding inside a text box and the distance between lines (in PDF points)
export const TEXT_PADDING = 4;
export const LINE_HEIGHT = 1.2;
