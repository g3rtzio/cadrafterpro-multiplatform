import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { LINE_HEIGHT, Markup, TEXT_PADDING, wrapText } from '../models/elements';
import { COLORS, Pt, Rect, rectFromPoints } from '../models/takeoff';
import { DrawingStore } from './drawing.store';
import { PageGeometry } from './pdf-render';
import { textWidth } from './shapes';

// Markup tools of the Home tab (like Bluebeam Revu): text box, callout, cloud, rectangle, ellipse,
// line, arrow, polyline, polygon, pen and highlight. The markups they draw are ordinary PDF markups
// (Markup objects in the store), written to the PDF with their own appearance when saving.

export type MarkupToolKind =
  | 'text' | 'callout' | 'cloud' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'polyline' | 'polygon' | 'pen' | 'highlight';

export interface MarkupToolInfo { kind: MarkupToolKind; title: string; icon: string; subject: string; hint: string; }

export const MARKUP_TOOLS: MarkupToolInfo[] = [
  { kind: 'text', title: 'Text Box', icon: 'text_fields', subject: 'Text Box', hint: 'Click or drag a box, then type' },
  { kind: 'callout', title: 'Callout', icon: 'comment', subject: 'Callout', hint: 'Press on the arrow tip and drag to the text' },
  { kind: 'cloud', title: 'Cloud', icon: 'cloud', subject: 'Cloud', hint: 'Drag a box' },
  { kind: 'rectangle', title: 'Rectangle', icon: 'rectangle', subject: 'Rectangle', hint: 'Drag a box' },
  { kind: 'ellipse', title: 'Ellipse', icon: 'circle', subject: 'Ellipse', hint: 'Drag a box' },
  { kind: 'line', title: 'Line', icon: 'pen_size_2', subject: 'Line', hint: 'Drag from start to end' },
  { kind: 'arrow', title: 'Arrow', icon: 'arrow_outward', subject: 'Arrow', hint: 'Drag from the arrow tip to the tail' },
  { kind: 'polyline', title: 'Polyline', icon: 'polyline', subject: 'Polyline', hint: 'Click each point, double click or Enter to finish' },
  { kind: 'polygon', title: 'Polygon', icon: 'hexagon', subject: 'Polygon', hint: 'Click each point, double click or Enter to finish' },
  { kind: 'pen', title: 'Pen', icon: 'draw', subject: 'Pen', hint: 'Draw freehand' },
  { kind: 'highlight', title: 'Highlight', icon: 'ink_highlighter', subject: 'Highlight', hint: 'Draw over the text' },
];

// Default look of each tool (shown and edited in the Settings panel while the tool is active)
export interface MarkupStyle {
  color: string;
  fillColor: string | null;
  lineWidth: number;
  opacity: number;
  fontSize: number;
  textColor: string;
}

const RED = COLORS.red;

function defaultStyle(kind: MarkupToolKind): MarkupStyle {
  const base: MarkupStyle = { color: RED, fillColor: null, lineWidth: 1, opacity: 1, fontSize: 12, textColor: RED };
  switch (kind) {
    case 'text': return { ...base, lineWidth: 0 };
    case 'pen': return { ...base, lineWidth: 1.5 };
    case 'highlight': return { ...base, color: '#FFFF00', lineWidth: 12 };
    default: return base;
  }
}

const STORAGE_KEY = 'cadrafterpro.markupStyles';

@Injectable({ providedIn: 'root' })
export class MarkupTools {
  private readonly store = inject(DrawingStore);

  readonly tool = signal<MarkupToolKind | null>(null);
  // Clicks of a polyline or polygon in progress
  readonly clicks = signal<{ pageIndex: number; points: Pt[] } | null>(null);
  // Text box open in the editor on the plan
  readonly editing = signal<Markup | null>(null);
  // Bumped when a tool style changes (the panel and the preview redraw)
  readonly styleVersion = signal(0);
  readonly styles = new Map<MarkupToolKind, MarkupStyle>(MARKUP_TOOLS.map(t => [t.kind, defaultStyle(t.kind)]));

  constructor() {
    this.loadStyles();
    // A takeoff tool, the Estimating tab, a viewport box or closing the drawing ends the markup tool
    effect(() => {
      const s = this.store.watch();
      const stop = s.tool !== 'none' || s.ribbonTab !== 'Home' || !s.hasDocument || s.drawingViewport;
      untracked(() => {
        if (stop && this.tool()) this.cancel();
        if (!s.hasDocument && this.editing()) this.editing.set(null);
      });
    });
  }

  info(kind: MarkupToolKind): MarkupToolInfo {
    return MARKUP_TOOLS.find(t => t.kind === kind)!;
  }

  style(kind: MarkupToolKind): MarkupStyle {
    return this.styles.get(kind)!;
  }

  // Ribbon button: starts the tool (or stops it when it is already on)
  start(kind: MarkupToolKind): void {
    if (!this.store.hasDocument) return;
    if (this.tool() === kind) {
      this.cancel();
      return;
    }
    this.store.cancelTool();
    this.clicks.set(null);
    this.tool.set(kind);
    this.store.selectElements([]);
  }

  // Esc: a polyline or polygon in progress is kept (like Revu), then the tool ends
  cancel(): void {
    this.finishClicks(null);
    this.tool.set(null);
    this.clicks.set(null);
  }

  get isClickTool(): boolean {
    const t = this.tool();
    return t === 'polyline' || t === 'polygon';
  }

  get isFreehand(): boolean {
    const t = this.tool();
    return t === 'pen' || t === 'highlight';
  }

  // MARK: - Polyline and polygon (one click per point)
  addClick(point: Pt, pageIndex: number): void {
    const current = this.clicks();
    if (current && current.pageIndex !== pageIndex) return;
    this.clicks.set({ pageIndex, points: [...(current?.points ?? []), point] });
  }

  // Double click or Enter: the markup is made from the clicks
  finishClicks(g: PageGeometry | null): void {
    const current = this.clicks();
    const kind = this.tool();
    this.clicks.set(null);
    if (!current || !kind) return;
    // A double click also lands as a click on the same spot: drop repeated points
    const points = current.points.filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 0.5);
    const m = this.build(kind, current.pageIndex, points, g);
    if (m) this.add(m);
  }

  // MARK: - Making the markup
  // path: the drag (start, …, end) or the clicks, in page coordinates.
  // g: the page, to place text boxes the way they look on screen. Returns null when it is too small.
  build(kind: MarkupToolKind, pageIndex: number, path: Pt[], g: PageGeometry | null): Markup | null {
    if (path.length === 0) return null;
    const st = this.style(kind);
    const m = new Markup(pageIndex);
    m.appMade = true;
    m.dirty = true;
    m.subject = this.info(kind).subject;
    m.author = 'CadrafterPro';
    m.color = st.color;
    m.fillColor = st.fillColor;
    m.fillOpacity = st.fillColor ? 1 : null;
    m.lineWidth = st.lineWidth;
    m.opacity = st.opacity;
    const a = path[0];
    const b = path[path.length - 1];
    const box = rectFromPoints(a, b);
    const tiny = (r: Rect) => r.w < 2 && r.h < 2;

    switch (kind) {
      case 'rectangle':
      case 'ellipse':
        if (tiny(box)) return null;
        m.subtype = kind === 'rectangle' ? 'Square' : 'Circle';
        m.rect = box;
        break;
      case 'cloud':
        if (tiny(box)) return null;
        m.subtype = 'Polygon';
        m.intent = 'PolygonCloud';
        m.cloud = 1;
        m.vertices = [
          { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
          { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
        ];
        break;
      case 'line':
      case 'arrow':
        if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return null;
        m.subtype = 'Line';
        m.line = [a, b];
        // Revu puts the arrowhead at the first point
        if (kind === 'arrow') m.lineEnds = ['OpenArrow', 'None'];
        break;
      case 'polyline':
        if (path.length < 2) return null;
        m.subtype = 'PolyLine';
        m.vertices = path;
        break;
      case 'polygon':
        if (path.length < 3) return null;
        m.subtype = 'Polygon';
        m.vertices = path;
        break;
      case 'pen':
      case 'highlight':
        if (path.length < 2) return null;
        m.subtype = 'Ink';
        m.inkList = [path];
        if (kind === 'highlight') m.multiply = true;
        break;
      case 'text':
      case 'callout': {
        m.subtype = 'FreeText';
        m.fontSize = st.fontSize;
        m.textColor = st.textColor;
        if (st.lineWidth === 0) m.color = st.color;
        m.textBox = kind === 'text' ? this.textBoxFor(a, b, st.fontSize, g) : this.calloutBoxFor(a, b, st.fontSize, g);
        if (kind === 'callout') {
          m.intent = 'FreeTextCallout';
          m.lineEnds = ['OpenArrow'];
          m.lineWidth = Math.max(st.lineWidth, 1);
          m.callout = this.leader(a, m.textBox, g);
        }
        break;
      }
    }
    m.updateRect();
    return m;
  }

  // Text box: the dragged box, or a one-line box to the right of / below the click
  private textBoxFor(a: Pt, b: Pt, fontSize: number, g: PageGeometry | null): Rect {
    const lineBox = (corner: Pt): Rect => this.viewBox(corner, 160, fontSize * LINE_HEIGHT + TEXT_PADDING * 2, g);
    const dragged = rectFromPoints(a, b);
    if (dragged.w < 8 && dragged.h < 8) return lineBox(a);
    return dragged;
  }

  // Callout: its text box sits where the drag ended, on the far side from the arrow tip
  private calloutBoxFor(tip: Pt, end: Pt, fontSize: number, g: PageGeometry | null): Rect {
    const w = 140, h = fontSize * LINE_HEIGHT + TEXT_PADDING * 2;
    if (!g) return { x: end.x, y: end.y - h / 2, w, h };
    const vt = g.toView(tip), ve = g.toView(end);
    // A click without a drag: the text goes up and to the right of the tip
    const target = Math.hypot(ve.x - vt.x, ve.y - vt.y) < 8 ? { x: vt.x + 50, y: vt.y - 40 } : ve;
    const left = target.x >= vt.x ? target.x : target.x - w;
    return g.rectToPage({ x: left, y: target.y - h / 2, w, h });
  }

  // Leader line of a callout: tip, a short horizontal landing, and the middle of the box's near side
  leader(tip: Pt, box: Rect, g: PageGeometry | null): Pt[] {
    if (!g) {
      const attach = { x: tip.x <= box.x + box.w / 2 ? box.x : box.x + box.w, y: box.y + box.h / 2 };
      return [tip, { x: attach.x + (attach.x === box.x ? -12 : 12), y: attach.y }, attach];
    }
    const v = g.rectToView(box);
    const vt = g.toView(tip);
    const onLeft = vt.x <= v.x + v.w / 2;
    const attach = { x: onLeft ? v.x : v.x + v.w, y: v.y + v.h / 2 };
    const knee = { x: attach.x + (onLeft ? -14 : 14), y: attach.y };
    return [tip, g.toPage(knee), g.toPage(attach)];
  }

  // A box of w × h (view units) whose top-left corner is `corner` on screen
  private viewBox(corner: Pt, w: number, h: number, g: PageGeometry | null): Rect {
    if (!g) return { x: corner.x, y: corner.y - h, w, h };
    const v = g.toView(corner);
    return g.rectToPage({ x: v.x, y: v.y, w, h });
  }

  // Adds a new markup (one Undo step), selects it and leaves the tool (like Revu)
  add(m: Markup): void {
    this.store.checkpoint();
    this.store.markups.push(m);
    this.tool.set(null);
    this.store.selectElements([m]);
    if (m.isTextBox) this.editing.set(m);
  }

  // MARK: - Text of a text box or callout
  startEditing(m: Markup): void {
    if (!m.isTextBox) return;
    this.store.selectElements([m]);
    this.editing.set(m);
  }

  // Editor closed: saves the text. A new box left empty goes away.
  commitText(m: Markup, text: string, g: PageGeometry | null): void {
    this.editing.set(null);
    if (!this.store.markups.includes(m)) return;
    if (!text.trim() && !m.contents.trim()) {
      this.store.selectElements([m]);
      this.store.deleteSelected();
      return;
    }
    if (text === m.contents) return;
    this.store.checkpoint('contents');
    m.contents = text;
    this.fitText(m, g);
    m.dirty = true;
    this.store.touch();
  }

  // Grows the box downwards so every line fits (the top stays where it is)
  fitText(m: Markup, g: PageGeometry | null): void {
    const box = m.textRect;
    const lines = wrapText(m.contents, Math.max(box.w - TEXT_PADDING * 2, m.fontSize), s => textWidth(s, m.fontSize));
    const needed = lines.length * m.fontSize * LINE_HEIGHT + TEXT_PADDING * 2;
    if (needed > box.h + 0.5) {
      const grown = { ...box, y: box.y + box.h - needed, h: needed };
      if (m.textBox) m.textBox = grown; else m.rect = grown;
      if (m.callout) m.callout = this.leader(m.callout[0], grown, g);
    }
    m.updateRect();
  }

  // MARK: - Editing selected markups (Settings panel)
  get selectedMarkups(): Markup[] {
    return this.store.selection.filter((el): el is Markup => el instanceof Markup);
  }

  edit(key: string, change: (m: Markup) => void): void {
    const list = this.selectedMarkups;
    if (list.length === 0) return;
    this.store.checkpoint(key);
    for (const m of list) {
      change(m);
      if (m.isTextBox) this.fitText(m, null); else m.updateRect();
      m.dirty = true;
    }
    this.store.touch();
  }

  // Changes the default look of the active tool
  setStyle(kind: MarkupToolKind, change: Partial<MarkupStyle>): void {
    Object.assign(this.style(kind), change);
    this.styleVersion.update(v => v + 1);
    this.saveStyles();
  }

  private loadStyles(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Partial<MarkupStyle>>;
      for (const [kind, style] of Object.entries(saved)) {
        const current = this.styles.get(kind as MarkupToolKind);
        if (current) Object.assign(current, style);
      }
    } catch {
      // private window or blocked storage: keep the defaults
    }
  }

  private saveStyles(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.styles)));
    } catch {
      // not saved: the styles last until the page is closed
    }
  }
}
