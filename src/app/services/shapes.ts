import { Markup, Measurement, pointAtHalfLength } from '../models/elements';
import { COLORS, Pt, Rect, dashPattern, rectContains } from '../models/takeoff';
import { DrawingStore } from './drawing.store';
import { PageGeometry } from './pdf-render';

// What the SVG layer draws: paths and texts in view coordinates
// (port of LivePreviewView.drawMeasurements and of PDFKit drawing the markups)
export interface Shape {
  d?: string; // path
  text?: string;
  x?: number;
  y?: number;
  fill: string;
  fillOpacity?: number;
  stroke: string;
  width: number;
  dash?: string;
  opacity: number;
  blend?: string; // "multiply" for Revu highlights
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  anchor?: 'start' | 'middle';
  baseline?: 'middle' | 'auto' | 'hanging';
}

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

export function fontFamily(name: string): string {
  return name === 'System' ? SYSTEM_FONT : `"${name}", ${SYSTEM_FONT}`;
}

export function pathOf(points: Pt[], close: boolean): string {
  if (points.length === 0) return '';
  return (
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
    (close ? ' Z' : '')
  );
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
export function pageShapes(
  store: DrawingStore,
  pageIndex: number,
  g: PageGeometry,
  zoom: number,
  withSelection = true,
): Shape[] {
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
      shapes.push({
        d: rectPath(r),
        fill: 'none',
        stroke: COLORS.blue,
        width: 2 * px,
        dash: `${4 * px} ${3 * px}`,
        opacity: 1,
      });
    }
  }
  return shapes;
}

// Viewport box (dashed, with its name and scale in the top-left corner).
// Shown only while measuring, for the viewport under the cursor (`point`, page coordinates).
export function viewportShapes(
  store: DrawingStore,
  pageIndex: number,
  g: PageGeometry,
  zoom: number,
  point: Pt | null,
): Shape[] {
  if (!point) return [];
  const px = 1 / zoom;
  const shapes: Shape[] = [];
  const v = [...store.viewports]
    .reverse()
    .find((v) => v.pageIndex === pageIndex && rectContains(v.rect, point));
  if (!v) return shapes;
  const box = store.viewportBoxes(pageIndex).find((b) => b.rect === v.rect);
  const r = g.rectToView(v.rect);
  shapes.push({
    d: rectPath(r),
    fill: COLORS.teal,
    fillOpacity: 0.06,
    stroke: COLORS.teal,
    width: 1.5 * px,
    dash: `${6 * px} ${4 * px}`,
    opacity: 1,
  });
  shapes.push({
    text: box?.title ?? v.name,
    x: r.x + 4 * px,
    y: r.y + 3 * px,
    fill: COLORS.teal,
    stroke: 'none',
    width: 0,
    opacity: 1,
    fontSize: 11 * px,
    fontFamily: SYSTEM_FONT,
    fontWeight: '600',
    anchor: 'start',
    baseline: 'hanging',
  });
  return shapes;
}

// App measurement, drawn as vectors (sharp at any zoom)
function measurementShapes(
  m: Measurement,
  toView: (p: Pt) => Pt,
  zoom: number,
  shapes: Shape[],
): void {
  if (m.points.length === 0) return;
  const points = m.points.map(toView);
  const width = Math.max(m.lineWidth, 0.5 / zoom);
  switch (m.kind) {
    case 'count':
      for (const v of points) {
        shapes.push({
          d: circlePath(v, Math.max(Measurement.countRadius, 3 / zoom)),
          fill: m.lineColor,
          stroke: 'none',
          width: 0,
          opacity: m.opacity,
        });
      }
      break;
    default: {
      if (points.length < 2) break;
      const dash = dashPattern(m.lineStyle, width);
      shapes.push({
        d: pathOf(points, m.kind === 'area'),
        fill: m.kind === 'area' ? m.areaFillColor : 'none',
        fillOpacity: m.fillOpacity,
        stroke: m.lineColor,
        width,
        dash: dash.length ? dash.join(' ') : undefined,
        opacity: m.opacity,
      });
      // Arrowheads (Dimension)
      for (const head of m.arrowHeads(points, Math.max(width * 6, 9 / zoom))) {
        shapes.push({
          d: pathOf(head, true),
          fill: m.lineColor,
          stroke: 'none',
          width: 0,
          opacity: m.opacity,
        });
      }
    }
  }

  // Measurement text ("125.40 ft") next to the measurement, unless Show caption is off
  const anchor = m.captionAnchor;
  if (!m.showCaption || !m.contents || !anchor || m.captionFontSize * zoom < 3) return;
  const a = toView(anchor);
  const base: Shape = {
    text: m.contents,
    fill: m.captionTextColor,
    stroke: 'none',
    width: 0,
    opacity: m.opacity,
    fontSize: m.captionFontSize,
    fontFamily: fontFamily(m.captionFontName),
    fontWeight: m.captionBold ? '700' : '400',
    fontStyle: m.captionItalic ? 'italic' : 'normal',
  };
  switch (m.kind) {
    case 'count':
      shapes.push({ ...base, x: a.x, y: a.y, anchor: 'start', baseline: 'middle' });
      break;
    case 'area':
      shapes.push({ ...base, x: a.x, y: a.y, anchor: 'middle', baseline: 'middle' });
      break;
    default:
      shapes.push({ ...base, x: a.x, y: a.y - (width + 2), anchor: 'middle', baseline: 'auto' });
  }
}

// PDF markup (Revu or another app), drawn from its geometry
function markupShapes(m: Markup, g: PageGeometry, shapes: Shape[]): void {
  const stroke = m.color ?? 'none';
  const width = m.lineWidth;
  const dash = m.dashed ? `${3 * width} ${2 * width}` : undefined;
  const fill = m.fillColor ?? 'none';
  const fillOpacity = m.fillOpacity ?? 1;
  const r = g.rectToView(m.rect);

  switch (m.subtype) {
    case 'Polygon':
    case 'PolyLine': {
      if (!m.vertices) break;
      const pts = m.vertices.map((p) => g.toView(p));
      const closed = m.subtype === 'Polygon';
      shapes.push({
        d: pathOf(pts, closed),
        fill: closed ? fill : 'none',
        fillOpacity,
        stroke,
        width: width > 0 ? width : 0,
        dash,
        opacity: m.opacity,
      });
      break;
    }
    case 'Line':
      if (m.line)
        shapes.push({
          d: pathOf(
            m.line.map((p) => g.toView(p)),
            false,
          ),
          fill: 'none',
          stroke,
          width,
          dash,
          opacity: m.opacity,
        });
      break;
    case 'Square': {
      const inset = {
        x: r.x + width / 2,
        y: r.y + width / 2,
        w: Math.max(r.w - width, 0),
        h: Math.max(r.h - width, 0),
      };
      shapes.push({
        d: rectPath(inset),
        fill,
        fillOpacity,
        stroke,
        width,
        dash,
        opacity: m.opacity,
      });
      break;
    }
    case 'Circle':
      shapes.push({
        d: `M${r.x} ${r.y + r.h / 2} a${r.w / 2} ${r.h / 2} 0 1 0 ${r.w} 0 a${r.w / 2} ${r.h / 2} 0 1 0 ${-r.w} 0 Z`,
        fill,
        fillOpacity,
        stroke,
        width,
        dash,
        opacity: m.opacity,
      });
      break;
    case 'Ink':
      // Revu Highlight: thick stroke with "Multiply", so the text stays visible underneath
      for (const path of m.inkList ?? []) {
        shapes.push({
          d: pathOf(
            path.map((p) => g.toView(p)),
            false,
          ),
          fill: 'none',
          stroke,
          width: Math.max(width, 1),
          opacity: m.opacity,
          blend: m.isHighlight ? 'multiply' : undefined,
        });
      }
      break;
    case 'Highlight':
      shapes.push({
        d: rectPath(r),
        fill: m.color ?? COLORS.yellow,
        fillOpacity: 0.5,
        stroke: 'none',
        width: 0,
        opacity: 1,
        blend: 'multiply',
      });
      break;
    case 'FreeText':
      if (width > 0 && m.color)
        shapes.push({ d: rectPath(r), fill: 'none', stroke, width, opacity: m.opacity });
      shapes.push({
        text: m.contents,
        x: r.x + 3,
        y: r.y + 3,
        fill: COLORS.black,
        stroke: 'none',
        width: 0,
        opacity: 1,
        fontSize: 10,
        fontFamily: SYSTEM_FONT,
        anchor: 'start',
        baseline: 'hanging',
      });
      break;
    case 'Text':
      // Sticky note
      shapes.push({
        d: rectPath({ x: r.x, y: r.y, w: 16, h: 16 }),
        fill: m.color ?? COLORS.yellow,
        stroke: '#666',
        width: 0.5,
        opacity: 1,
      });
      break;
    default:
      // Stamps and anything else: its box and its name
      shapes.push({
        d: rectPath(r),
        fill: 'none',
        stroke: m.color ?? COLORS.gray,
        width: 1,
        dash: '4 3',
        opacity: 0.8,
      });
      shapes.push({
        text: m.name,
        x: r.x + r.w / 2,
        y: r.y + r.h / 2,
        fill: m.color ?? COLORS.gray,
        stroke: 'none',
        width: 0,
        opacity: 0.9,
        fontSize: Math.min(12, Math.max(r.h / 3, 4)),
        fontFamily: SYSTEM_FONT,
        anchor: 'middle',
        baseline: 'middle',
      });
  }

  // Revu measurement markups: their value next to the shape
  if (m.isRevuMeasurement && m.contents && m.vertices && !m.intent.includes('Count')) {
    const pts = m.vertices.map((p) => g.toView(p));
    const isArea = m.subtype === 'Polygon';
    const a = isArea
      ? {
          x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
          y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
        }
      : pointAtHalfLength(pts);
    shapes.push({
      text: m.contents,
      x: a.x,
      y: isArea ? a.y : a.y - width - 2,
      fill: m.color ?? COLORS.black,
      stroke: 'none',
      width: 0,
      opacity: m.opacity,
      fontSize: 10,
      fontFamily: SYSTEM_FONT,
      anchor: 'middle',
      baseline: isArea ? 'middle' : 'auto',
    });
  }
}
