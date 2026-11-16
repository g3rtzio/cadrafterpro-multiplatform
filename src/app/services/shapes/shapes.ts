import {
  readableAngleAtHalfLength,
  Cubic, LINE_HEIGHT, Markup, Measurement, TEXT_PADDING, cloudCurves, ellipseCurves, lineEnding, pointAtHalfLength,
  wrapText,
} from '../../models/elements';
import { COLORS, Pt, Rect, dashPattern, rectContains } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { PageGeometry } from '../pdf-render/pdf-render';

// What the SVG layer draws: paths and texts in view coordinates
// (port of LivePreviewView.drawMeasurements and of PDFKit drawing the markups)
export interface Shape {
  d?: string;                      // path
  text?: string;
  x?: number;
  y?: number;
  fill: string;
  fillOpacity?: number;
  stroke: string;
  width: number;
  dash?: string;
  opacity: number;
  blend?: string;                  // "multiply" for Revu highlights
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  anchor?: 'start' | 'middle';
  rotate?: number;                 // text turned around (x, y), in degrees (follows a dimension line)
  baseline?: 'middle' | 'auto' | 'hanging';
  href?: string;                   // picture (pasted snapshot), drawn in the box x, y, w, h
  w?: number;
  h?: number;
}

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

export function fontFamily(name: string): string {
  return name === 'System' ? SYSTEM_FONT : `"${name}", ${SYSTEM_FONT}`;
}

export function pathOf(points: Pt[], close: boolean): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + (close ? ' Z' : '');
}

export function rectPath(r: Rect): string {
  return `M${r.x} ${r.y} h${r.w} v${r.h} h${-r.w} Z`;
}

function circlePath(c: Pt, r: number): string {
  return `M${c.x - r} ${c.y} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

// Everything drawn on one page: PDF markups, app measurements and the selection.
// zoom: screen pixels per view unit (line widths and texts grow with it, like things printed on the plan;
// boxes and labels that must keep their size on screen are divided by it).
export function pageShapes(store: DrawingStore, pageIndex: number, g: PageGeometry, zoom: number,
                           withSelection = true): Shape[] {
  const shapes: Shape[] = [];
  const px = 1 / zoom;
  const toView = (p: Pt) => g.toView(p);

  for (const el of store.elementsOn(pageIndex)) {
    if (!el.visible) continue;
    if (el instanceof Measurement) measurementShapes(el, toView, zoom, shapes);
    else markupShapes(el, g, shapes);
  }

  // Blue dashed box around the selected elements
  if (withSelection) {
    for (const el of store.selection) {
      if (el.pageIndex !== pageIndex) continue;
      const b = el.bounds;
      const r = g.rectToView({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 });
      shapes.push({ d: rectPath(r), fill: 'none', stroke: COLORS.blue, width: 2 * px, dash: `${4 * px} ${3 * px}`, opacity: 1 });
    }
  }
  return shapes;
}

// Viewport box (dashed, with its name and scale in the top-left corner).
// Shown only while measuring, for the viewport under the cursor (`point`, page coordinates).
export function viewportShapes(store: DrawingStore, pageIndex: number, g: PageGeometry, zoom: number,
                               point: Pt | null): Shape[] {
  if (!point) return [];
  const px = 1 / zoom;
  const shapes: Shape[] = [];
  const v = [...store.viewports].reverse().find(v => v.pageIndex === pageIndex && rectContains(v.rect, point));
  if (!v) return shapes;
  const box = store.viewportBoxes(pageIndex).find(b => b.rect === v.rect);
  const r = g.rectToView(v.rect);
  shapes.push({ d: rectPath(r), fill: COLORS.teal, fillOpacity: 0.06, stroke: COLORS.teal, width: 1.5 * px,
    dash: `${6 * px} ${4 * px}`, opacity: 1 });
  shapes.push({ text: box?.title ?? v.name, x: r.x + 4 * px, y: r.y + 3 * px, fill: COLORS.teal, stroke: 'none', width: 0,
    opacity: 1, fontSize: 11 * px, fontFamily: SYSTEM_FONT, fontWeight: '600', anchor: 'start', baseline: 'hanging' });
  return shapes;
}

// App measurement, drawn as vectors (sharp at any zoom)
function measurementShapes(m: Measurement, toView: (p: Pt) => Pt, zoom: number, shapes: Shape[]): void {
  if (m.points.length === 0) return;
  const points = m.points.map(toView);
  const width = Math.max(m.lineWidth, 0.5 / zoom);
  switch (m.kind) {
    case 'count':
      for (const v of points) {
        shapes.push({ d: circlePath(v, Math.max(Measurement.countRadius, 3 / zoom)), fill: m.lineColor, stroke: 'none',
          width: 0, opacity: m.opacity });
      }
      break;
    default: {
      if (points.length < 2) break;
      const dash = dashPattern(m.lineStyle, width);
      shapes.push({
        d: pathOf(points, m.kind === 'area'),
        fill: m.kind === 'area' ? m.areaFillColor : 'none', fillOpacity: m.fillOpacity,
        stroke: m.lineColor, width, dash: dash.length ? dash.join(' ') : undefined, opacity: m.opacity,
      });
      // Arrowheads (Dimension)
      for (const head of m.arrowHeads(points, Math.max(width * 6, 9 / zoom))) {
        shapes.push({ d: pathOf(head, true), fill: m.lineColor, stroke: 'none', width: 0, opacity: m.opacity });
      }
    }
  }

  // Measurement text ("125.40 ft") next to the measurement, unless Show caption is off
  const anchor = m.captionAnchor;
  if (!m.showCaption || !m.contents || !anchor || m.captionFontSize * zoom < 3) return;
  const a = toView(anchor);
  const base: Shape = {
    text: m.contents, fill: m.captionTextColor, stroke: 'none', width: 0, opacity: m.opacity,
    fontSize: m.captionFontSize, fontFamily: fontFamily(m.captionFontName),
    fontWeight: m.captionBold ? '700' : '400', fontStyle: m.captionItalic ? 'italic' : 'normal',
  };
  switch (m.kind) {
    case 'count': shapes.push({ ...base, x: a.x, y: a.y, anchor: 'start', baseline: 'middle' }); break;
    case 'area': shapes.push({ ...base, x: a.x, y: a.y, anchor: 'middle', baseline: 'middle' }); break;
    default: shapes.push({ ...base, ...alongLine(points, a, width + 2), anchor: 'middle', baseline: 'auto' });
  }
}

// PDF markup (Revu or another app, or drawn with the Markup tools), drawn from its geometry.
// Exported so the plan can preview a markup while it is being drawn.
export function markupShapes(m: Markup, g: PageGeometry, shapes: Shape[]): void {
  const stroke = m.color ?? 'none';
  const width = m.lineWidth;
  const dash = m.dashed ? `${3 * Math.max(width, 1)} ${2 * Math.max(width, 1)}` : undefined;
  const fill = m.fillColor ?? 'none';
  const fillOpacity = m.fillOpacity ?? 1;
  const r = g.rectToView(m.rect);
  const toView = (p: Pt) => g.toView(p);

  switch (m.subtype) {
    case 'Polygon':
    case 'PolyLine': {
      if (!m.vertices) break;
      const closed = m.subtype === 'Polygon';
      const cloud = closed && m.cloud > 0 ? cloudCurves(m.vertices, m.cloudSize) : null;
      const d = cloud ? curvesPath(cloud.start, cloud.curves, toView, true) : pathOf(m.vertices.map(toView), closed);
      shapes.push({ d, fill: closed ? fill : 'none', fillOpacity, stroke, width: width > 0 ? width : 0, dash, opacity: m.opacity });
      if (!closed) endingShapes(m, m.vertices, toView, shapes);
      break;
    }
    case 'Line':
      if (m.line) {
        shapes.push({ d: pathOf(m.line.map(toView), false), fill: 'none', stroke, width, dash, opacity: m.opacity });
        endingShapes(m, m.line, toView, shapes);
      }
      break;
    case 'Square': {
      const inset = { x: r.x + width / 2, y: r.y + width / 2, w: Math.max(r.w - width, 0), h: Math.max(r.h - width, 0) };
      shapes.push({ d: rectPath(inset), fill, fillOpacity, stroke, width, dash, opacity: m.opacity });
      break;
    }
    case 'Circle': {
      const e = ellipseCurves({ x: m.rect.x + width / 2, y: m.rect.y + width / 2,
        w: Math.max(m.rect.w - width, 0), h: Math.max(m.rect.h - width, 0) });
      shapes.push({ d: curvesPath(e.start, e.curves, toView, true), fill, fillOpacity, stroke, width, dash, opacity: m.opacity });
      break;
    }
    case 'Ink':
      // Pen, and Revu Highlight: thick stroke with "Multiply", so the text stays visible underneath
      for (const path of m.inkList ?? []) {
        shapes.push({ d: pathOf(path.map(toView), false), fill: 'none', stroke, width: Math.max(width, 1),
          opacity: m.opacity, blend: m.isHighlight ? 'multiply' : undefined });
      }
      break;
    case 'Highlight':
    case 'Underline':
    case 'Squiggly':
    case 'StrikeOut':
    case 'Redact':
    case 'Link':
      textMarkupShapes(m, g, shapes);
      break;
    case 'FreeText':
      textBoxShapes(m, g, shapes);
      break;
    case 'Text':
      // Sticky note
      shapes.push({ d: rectPath({ x: r.x, y: r.y, w: 16, h: 16 }), fill: m.color ?? COLORS.yellow, stroke: '#666', width: 0.5, opacity: 1 });
      break;
    case 'Stamp':
      // Image markup (pasted snapshot): the picture itself
      if (m.imageUrl) {
        shapes.push({ href: m.imageUrl, x: r.x, y: r.y, w: r.w, h: r.h, fill: 'none', stroke: 'none', width: 0, opacity: m.opacity });
        break;
      }
      shapes.push({ d: rectPath(r), fill: 'none', stroke: m.color ?? COLORS.gray, width: 1, dash: '4 3', opacity: 0.8 });
      shapes.push({ text: m.name, x: r.x + r.w / 2, y: r.y + r.h / 2, fill: m.color ?? COLORS.gray, stroke: 'none', width: 0,
        opacity: 0.9, fontSize: Math.min(12, Math.max(r.h / 3, 4)), fontFamily: SYSTEM_FONT, anchor: 'middle', baseline: 'middle' });
      break;
    default:
      // Stamps and anything else: its box and its name
      shapes.push({ d: rectPath(r), fill: 'none', stroke: m.color ?? COLORS.gray, width: 1, dash: '4 3', opacity: 0.8 });
      shapes.push({ text: m.name, x: r.x + r.w / 2, y: r.y + r.h / 2, fill: m.color ?? COLORS.gray, stroke: 'none', width: 0,
        opacity: 0.9, fontSize: Math.min(12, Math.max(r.h / 3, 4)), fontFamily: SYSTEM_FONT, anchor: 'middle', baseline: 'middle' });
  }

  // Revu measurement markups: their value next to the shape
  if (m.isRevuMeasurement && m.contents && m.vertices && !m.intent.includes('Count')) {
    const pts = m.vertices.map(p => g.toView(p));
    const isArea = m.subtype === 'Polygon';
    const a = isArea
      ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length }
      : pointAtHalfLength(pts);
    const place = isArea ? { x: a.x, y: a.y } : alongLine(pts, a, width + 2);
    shapes.push({ text: m.contents, ...place, fill: m.color ?? COLORS.black,
      stroke: 'none', width: 0, opacity: m.opacity, fontSize: 10, fontFamily: SYSTEM_FONT, anchor: 'middle',
      baseline: isArea ? 'middle' : 'auto' });
  }
}

// Text box and callout: box (border and fill), leader line with its arrow, and the wrapped text
function textBoxShapes(m: Markup, g: PageGeometry, shapes: Shape[]): void {
  const box = g.rectToView(m.textRect);
  const color = m.color ?? COLORS.red;
  if (m.callout && m.callout.length >= 2) {
    const leader = m.callout.map(p => g.toView(p));
    shapes.push({ d: pathOf(leader, false), fill: 'none', stroke: color, width: Math.max(m.lineWidth, 0.75), opacity: m.opacity });
    const style = m.lineEnds?.[0] ?? 'OpenArrow';
    const end = lineEnding(style, leader[1], leader[0], m.arrowSize);
    if (end) shapes.push({ d: pathOf(end.points, end.closed), fill: end.closed ? color : 'none', stroke: color,
      width: Math.max(m.lineWidth, 0.75), opacity: m.opacity });
  }
  if (m.fillColor || (m.lineWidth > 0 && m.color)) {
    shapes.push({ d: rectPath(box), fill: m.fillColor ?? 'none', fillOpacity: m.fillOpacity ?? 1,
      stroke: m.lineWidth > 0 && m.color ? color : 'none', width: m.lineWidth, opacity: m.opacity });
  }
  const size = m.fontSize;
  const lines = wrapText(m.contents, Math.max(box.w - TEXT_PADDING * 2, size), s => textWidth(s, size));
  lines.forEach((line, i) => {
    if (!line) return;
    shapes.push({ text: line, x: box.x + TEXT_PADDING, y: box.y + TEXT_PADDING + i * size * LINE_HEIGHT,
      fill: m.textColor ?? COLORS.black, stroke: 'none', width: 0, opacity: m.opacity, fontSize: size,
      fontFamily: TEXT_FONT, anchor: 'start', baseline: 'hanging' });
  });
}

// Arrowheads at the ends of a line or polyline markup (/LE)
function endingShapes(m: Markup, points: Pt[], toView: (p: Pt) => Pt, shapes: Shape[]): void {
  if (!m.lineEnds || points.length < 2) return;
  const color = m.color ?? COLORS.black;
  const view = points.map(toView);
  const ends = [
    lineEnding(m.lineEnds[0], view[1], view[0], m.arrowSize),
    lineEnding(m.lineEnds[1] ?? 'None', view[view.length - 2], view[view.length - 1], m.arrowSize),
  ];
  for (const end of ends) {
    if (end) shapes.push({ d: pathOf(end.points, end.closed), fill: end.closed ? color : 'none', stroke: color,
      width: Math.max(m.lineWidth, 0.75), opacity: m.opacity });
  }
}

// SVG path of Bézier pieces (page coordinates converted to view coordinates)
function curvesPath(start: Pt, curves: Cubic[], toView: (p: Pt) => Pt, close: boolean): string {
  const f = (p: Pt) => { const v = toView(p); return `${v.x.toFixed(2)} ${v.y.toFixed(2)}`; };
  return `M${f(start)} ` + curves.map(c => `C${f(c[0])} ${f(c[1])} ${f(c[2])}`).join(' ') + (close ? ' Z' : '');
}

// Text boxes use Helvetica (Arial on Windows), the same font the PDF appearance uses
export const TEXT_FONT = 'Helvetica, Arial, sans-serif';

let measureContext: CanvasRenderingContext2D | null = null;

// Width of a text in Helvetica at `size` points
export function textWidth(text: string, size: number): number {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * size * 0.55;
  measureContext.font = `${size}px ${TEXT_FONT}`;
  return measureContext.measureText(text).width;
}

// Text markups (on search results): highlight, underline, squiggly, strikethrough, redaction mark, link
function textMarkupShapes(m: Markup, g: PageGeometry, shapes: Shape[]): void {
  const color = m.color ?? COLORS.yellow;
  for (const q of m.quads?.length ? m.quads : [m.rect]) {
    const r = g.rectToView(q);
    // Text runs left to right on screen: the bottom edge is the larger y
    const thick = Math.max(r.h * 0.07, 0.6);
    switch (m.subtype) {
      case 'Highlight':
        shapes.push({ d: rectPath(r), fill: color, fillOpacity: 0.5 * m.opacity, stroke: 'none', width: 0, opacity: 1, blend: 'multiply' });
        break;
      case 'Underline':
        shapes.push({ d: pathOf([{ x: r.x, y: r.y + r.h - thick }, { x: r.x + r.w, y: r.y + r.h - thick }], false),
          fill: 'none', stroke: color, width: thick, opacity: m.opacity });
        break;
      case 'StrikeOut':
        shapes.push({ d: pathOf([{ x: r.x, y: r.y + r.h * 0.55 }, { x: r.x + r.w, y: r.y + r.h * 0.55 }], false),
          fill: 'none', stroke: color, width: thick, opacity: m.opacity });
        break;
      case 'Squiggly': {
        const step = Math.max(r.h * 0.18, 1);
        const pts: Pt[] = [];
        for (let x = r.x, i = 0; x <= r.x + r.w + 0.01; x += step, i++) pts.push({ x, y: r.y + r.h - (i % 2 ? 0 : step) });
        shapes.push({ d: pathOf(pts, false), fill: 'none', stroke: color, width: thick, opacity: m.opacity });
        break;
      }
      case 'Redact':
        shapes.push({ d: rectPath(r), fill: COLORS.red, fillOpacity: 0.12, stroke: COLORS.red, width: thick, opacity: 1 });
        break;
      case 'Link':
        shapes.push({ d: rectPath(r), fill: COLORS.blue, fillOpacity: 0.08, stroke: COLORS.blue, width: thick,
          dash: `${thick * 3} ${thick * 2}`, opacity: 1 });
        break;
    }
  }
}

// Where a line's caption goes (view coordinates): `gap` above the middle of the line,
// turned to follow it, so a vertical dimension reads like the ones on the drawing
function alongLine(points: Pt[], middle: Pt, gap: number): { x: number; y: number; rotate?: number } {
  const angle = readableAngleAtHalfLength(points, true);
  if (Math.abs(angle) < 1e-3) return { x: middle.x, y: middle.y - gap };
  return { x: middle.x + Math.sin(angle) * gap, y: middle.y - Math.cos(angle) * gap, rotate: angle * 180 / Math.PI };
}
