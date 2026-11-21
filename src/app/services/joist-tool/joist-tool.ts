import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Measurement } from '../../models/elements';
import { COLORS, Pt, pointInPolygon } from '../../models/takeoff';
import { CalcTools } from '../calc-tools/calc-tools';
import { CutoutTool } from '../cutout-tool/cutout-tool';
import { DrawingStore } from '../drawing.store/drawing.store';
import { MarkupTools } from '../markup-tools/markup-tools';
import { TextSelect } from '../text-select/text-select';

// Joist Tool (Home > Takeoff, like PlanSwift's Joist Tool):
//   1. Draw the area (click its corners; double click, Enter or a click on the first corner closes it),
//      or start with an area already selected.
//   2. Click the start and the end of the joist direction.
//   3. Joists are drawn inside the area every "O.C. Spacing", parallel to that direction, starting at the
//      start point and with one joist along each edge. Holes (Cut Out) of the area are left out.
// The area is one item ("Joist Tool": square feet) and the joists another ("Standard Joist": length,
// one line per joist), so the estimate gets both totals. The panel on the plan changes the settings and
// draws, clears, regenerates or splits the joists of the selected area.
// Grid Tool (Home > Takeoff, next to Joist): the same tool with lines both ways. After the area is
// closed it is filled with horizontal and vertical lines at once (each set with its own spacing, and
// either one can be turned off); Draw Grid picks a turned direction instead. Items: "Grid Tool" (SF)
// and "Grid Lines" (LF).

export interface JoistSettings {
  name: string;             // area item
  joistType: string;        // joist item
  spacing: number;          // O.C. spacing, inches
  minLength: number;        // joists shorter than this are left out, inches (0 = keep all)
  pitch: number;            // rise per 12 (0 = flat); applied to the joist item in the estimate
  color: string;            // joist color (the area uses it too, with its fill)
  showLabels: boolean;      // length caption on every joist
  // Grid Tool only: lines both ways. "Along" lines run with the direction (horizontal unless one is
  // picked) every `spacing`; "across" lines run square to it every `crossSpacing`.
  along: boolean;
  across: boolean;
  crossSpacing: number;     // inches
}

// Joist Tool: one set of parallel lines. Grid Tool: the same, plus the lines square to them.
export type JoistKind = 'joist' | 'grid';

export type JoistMode = 'area' | 'direction' | 'split';

const DEFAULTS: Record<JoistKind, JoistSettings> = {
  joist: {
    name: 'Joist Tool', joistType: 'Standard Joist', spacing: 16, minLength: 0, pitch: 0,
    color: COLORS.orange, showLabels: false, along: true, across: false, crossSpacing: 16,
  },
  grid: {
    name: 'Grid Tool', joistType: 'Grid Lines', spacing: 24, minLength: 0, pitch: 0,
    color: COLORS.blue, showLabels: false, along: true, across: true, crossSpacing: 24,
  },
};

const STORAGE_KEY: Record<JoistKind, string> = { joist: 'joistSettings', grid: 'gridSettings' };

function loadSettings(kind: JoistKind): JoistSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY[kind]) ?? 'null');
    return saved ? { ...DEFAULTS[kind], ...saved } : { ...DEFAULTS[kind] };
  } catch {
    return { ...DEFAULTS[kind] };
  }
}

@Injectable({ providedIn: 'root' })
export class JoistTool {
  private readonly store = inject(DrawingStore);
  private readonly markups = inject(MarkupTools);
  private readonly textSelect = inject(TextSelect);
  private readonly calc = inject(CalcTools);
  private readonly cutout = inject(CutoutTool);

  readonly open = signal(false);                       // panel on screen
  readonly mode = signal<JoistMode | null>(null);      // what the next clicks do
  readonly current = signal<{ pageIndex: number; points: Pt[] } | null>(null);
  readonly area = signal<Measurement | null>(null);    // area the joists go in
  readonly kind = signal<JoistKind>('joist');
  readonly settings = signal<JoistSettings>(loadSettings('joist'));
  // Direction picked for each area (Regenerate draws again with it)
  private readonly directions = new WeakMap<Measurement, [Pt, Pt]>();

  constructor() {
    // A takeoff, markup or calculation tool, another tab or closing the drawing ends it
    effect(() => {
      const s = this.store.watch();
      const stop = s.tool !== 'none' || s.ribbonTab !== 'Home' || !s.hasDocument || s.drawingViewport
        || !!this.markups.tool() || this.textSelect.active() || !!this.calc.mode() || this.cutout.active()
        || s.snapshotMode !== 'none';
      untracked(() => {
        if (stop && this.open()) this.close();
        // The area was deleted (or undone): forget it
        const a = this.area();
        if (a && !s.measurements.includes(a)) this.area.set(null);
        // With no step active, selecting another area makes it the joist area
        const picked = this.open() && !this.mode() ? this.selectedArea() : null;
        if (picked && picked !== this.area()) this.area.set(picked);
      });
    });
  }

  // Ribbon button: with an area selected, pick the direction for it (Grid: draw it square to the
  // page right away); otherwise draw a new area
  toggle(kind: JoistKind = 'joist'): void {
    if (this.open() && this.kind() === kind) return this.close();
    if (!this.store.hasDocument) return;
    this.kind.set(kind);
    this.settings.set(loadSettings(kind));
    this.markups.cancel();
    this.textSelect.stop();
    this.calc.stop();
    if (this.cutout.active()) this.cutout.stop();
    this.store.cancelTool();
    const selected = this.selectedArea();
    this.open.set(true);
    this.area.set(selected);
    if (selected && kind === 'grid') {
      this.mode.set(null);
      this.current.set(null);
      if (this.hasScale(selected.pageIndex)) this.drawSquare(selected);
      return;
    }
    this.begin(selected ? 'direction' : 'area');
  }

  close(): void {
    this.open.set(false);
    this.mode.set(null);
    this.current.set(null);
  }

  update(change: Partial<JoistSettings>): void {
    const next = { ...this.settings(), ...change };
    this.settings.set(next);
    try { localStorage.setItem(STORAGE_KEY[this.kind()], JSON.stringify(next)); } catch { /* private window */ }
  }

  // Panel buttons
  begin(mode: JoistMode): void {
    if ((mode === 'direction' || mode === 'split') && !this.area()) mode = 'area';
    if (mode !== 'area' && !this.hasScale()) return;
    this.current.set(null);
    this.mode.set(mode);
  }

  // A click on the plan. closeDistance: how close (page units) to the first corner closes the area
  addPoint(pageIndex: number, point: Pt, closeDistance: number): void {
    const mode = this.mode();
    if (!mode) return;
    const now = this.current();
    const points = now && now.pageIndex === pageIndex ? now.points : [];
    if (mode === 'area') {
      const first = points[0];
      if (points.length >= 3 && first && Math.hypot(point.x - first.x, point.y - first.y) <= closeDistance) return this.finish();
      this.current.set({ pageIndex, points: [...points, point] });
      return;
    }
    const area = this.area();
    if (!area || area.pageIndex !== pageIndex) {
      this.store.showToast('Click on the page of the joist area.', true);
      return;
    }
    if (points.length === 0) {
      this.current.set({ pageIndex, points: [point] });
      return;
    }
    const [start] = points;
    this.current.set(null);
    if (Math.hypot(point.x - start.x, point.y - start.y) < 1e-3) return;
    if (mode === 'direction') {
      this.directions.set(area, [start, point]);
      this.mode.set(null);
      this.draw(area);
    } else {
      this.mode.set(null);
      this.split(area, start, point);
    }
  }

  // Double click / Enter: closes the area being drawn
  finish(): void {
    const now = this.current();
    if (this.mode() !== 'area' || !now) return;
    const points = dedupe(now.points);
    if (points.length < 3) {
      this.store.showToast('An area needs at least 3 corners.', true);
      return;
    }
    if (!this.hasScale(now.pageIndex)) return;
    const s = this.settings();
    this.store.checkpoint();
    const item = this.store.ensureItem(s.name.trim() || DEFAULTS[this.kind()].name, 'area', s.color);
    const area = this.store.makeMeasurement(item, now.pageIndex, points);
    this.store.replaceMeasurements([], [area]);
    this.store.selectElements([area]);
    this.area.set(area);
    this.current.set(null);
    if (this.kind() === 'grid') {
      this.mode.set(null);
      this.drawSquare(area);
    } else {
      this.mode.set('direction');
    }
  }

  // Grid: horizontal and vertical lines of the page, starting at the area's first corner
  private drawSquare(area: Measurement): void {
    const o = area.points[0];
    this.directions.set(area, [o, { x: o.x + 1, y: o.y }]);
    this.draw(area);
  }

  // Esc: drops the points in progress, then the step, then leaves the tool. Backspace: last point.
  escape(): void {
    if (this.current()) this.current.set(null);
    else if (this.mode()) this.mode.set(null);
    else this.close();
  }

  undoPoint(): void {
    const now = this.current();
    if (!now) return;
    this.current.set(now.points.length > 1 ? { ...now, points: now.points.slice(0, -1) } : null);
  }

  // MARK: - Joists of an area
  // Joists of the area: lines of the joist item whose middle is inside it (they survive save and reopen)
  joistsOf(area: Measurement): Measurement[] {
    const id = this.joistItem()?.id;
    if (!id) return [];
    return this.store.measurements.filter(m => m.itemId === id && m.pageIndex === area.pageIndex
      && m.points.length === 2 && pointInPolygon(mid(m.points[0], m.points[1]), area.points));
  }

  private joistItem() {
    const name = this.settings().joistType.trim() || DEFAULTS[this.kind()].joistType;
    return this.store.items.find(i => i.name === name && i.kind === 'length');
  }

  regenerate(): void {
    const area = this.area();
    if (!area) return;
    if (!this.directionOf(area) && this.kind() === 'grid') return this.drawSquare(area);
    if (!this.directionOf(area)) {
      this.store.showToast('Pick the joist direction first (Draw Joists).', true);
      return this.begin('direction');
    }
    this.draw(area);
  }

  clear(): void {
    const area = this.area();
    if (!area) return;
    const old = this.joistsOf(area);
    if (!old.length) return;
    this.store.checkpoint();
    this.store.replaceMeasurements(old, []);
    this.store.showToast(`${old.length} ${this.kind() === 'grid' ? 'grid lines' : 'joists'} removed`);
  }

  // Draws the joists of the area again with the current settings (one Undo step)
  private draw(area: Measurement): void {
    const dir = this.directionOf(area);
    if (!dir) return;
    const s = this.settings();
    const scale = this.store.feetPerPoint(area.pageIndex, area.points[0]);
    const spacing = (s.spacing / 12) / scale;              // inches → page points
    if (!(spacing > 0) || !isFinite(spacing)) {
      this.store.showToast('Set an O.C. spacing greater than 0.', true);
      return;
    }
    const minLength = (s.minLength / 12) / scale;
    const grid = this.kind() === 'grid';
    const crossSpacing = (s.crossSpacing / 12) / scale;
    if (grid && s.across && (!(crossSpacing > 0) || !isFinite(crossSpacing))) {
      this.store.showToast('Set a spacing greater than 0.', true);
      return;
    }
    if (grid && !s.along && !s.across) {
      this.store.showToast('Turn on the horizontal lines, the vertical lines or both.', true);
      return;
    }
    // The lines square to the direction: the same start, turned a quarter turn
    const [start, end] = dir;
    const squareEnd = { x: start.x - (end.y - start.y), y: start.y + (end.x - start.x) };
    const lines = [
      ...(!grid || s.along ? joistLines(area.points, area.cutouts, start, end, spacing) : []),
      ...(grid && s.across ? joistLines(area.points, area.cutouts, start, squareEnd, crossSpacing) : []),
    ].filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) >= Math.max(minLength, 1e-6));
    if (lines.length > 5000) {
      this.store.showToast('That would be more than 5000 lines. Check the scale and the spacing.', true);
      return;
    }
    this.store.checkpoint();
    const item = this.store.ensureItem(s.joistType.trim() || DEFAULTS[this.kind()].joistType, 'length', s.color);
    const added = lines.map(points => {
      const m = this.store.makeMeasurement(item, area.pageIndex, points);
      m.lineColor = s.color;
      m.showCaption = s.showLabels;
      m.captionFontSize = 8;
      return m;
    });
    this.store.replaceMeasurements(this.joistsOf(area), added);
    if (s.pitch > 0) this.store.applyPitch([item.name], s.pitch, false, true);
    const total = added.reduce((sum, m) => sum + this.store.measuredValue(m), 0);
    this.store.selectElements([area]);
    this.store.showToast(grid
      ? `${added.length} grid lines · ${total.toFixed(1)} ft`
      : `${added.length} joists at ${s.spacing}" O.C. · ${total.toFixed(1)} ft`);
  }

  // Joists crossed by the line from a to b are cut in two there
  private split(area: Measurement, a: Pt, b: Pt): void {
    const pieces: Measurement[] = [];
    const cut: Measurement[] = [];
    for (const m of this.joistsOf(area)) {
      const hit = crossing(m.points[0], m.points[1], a, b);
      if (!hit) continue;
      cut.push(m);
      for (const points of [[m.points[0], hit], [hit, m.points[1]]]) {
        const item = this.store.items.find(i => i.id === m.itemId)!;
        const piece = this.store.makeMeasurement(item, m.pageIndex, points);
        piece.lineColor = m.lineColor;
        piece.showCaption = m.showCaption;
        piece.captionFontSize = m.captionFontSize;
        pieces.push(piece);
      }
    }
    if (!cut.length) {
      this.store.showToast('The split line doesn\'t cross any joist of this area.', true);
      return;
    }
    this.store.checkpoint();
    this.store.replaceMeasurements(cut, pieces);
    this.store.showToast(`${cut.length} ${this.kind() === 'grid' ? 'grid lines' : 'joists'} split`);
  }

  // Direction picked for the area, or the one its joists already have (an area from a saved file)
  private directionOf(area: Measurement): [Pt, Pt] | null {
    const known = this.directions.get(area);
    if (known) return known;
    const line = this.joistsOf(area)[0];
    return line ? [line.points[0], line.points[1]] : null;
  }

  private selectedArea(): Measurement | null {
    return this.store.selection.find((el): el is Measurement => el instanceof Measurement && el.kind === 'area') ?? null;
  }

  // Joists need the page scale (feet per point)
  private hasScale(pageIndex = this.area()?.pageIndex ?? this.store.currentPageIndex): boolean {
    if (this.store.hasScale(pageIndex)) return true;
    this.store.showToast('Set the scale of this page first (Home > Scale).', true);
    return false;
  }
}

// MARK: - Geometry
// Lines parallel to start → end, every `spacing` across it, clipped to the outline minus its holes.
// The first joist goes through the start point; one more goes along each edge of the area.
export function joistLines(outline: Pt[], holes: Pt[][], start: Pt, end: Pt, spacing: number): [Pt, Pt][] {
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (outline.length < 3 || len === 0 || !(spacing > 0)) return [];
  const d = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };   // along the joists
  const n = { x: -d.y, y: d.x };                                          // across them
  const across = (p: Pt) => p.x * n.x + p.y * n.y;
  const along = (p: Pt) => p.x * d.x + p.y * d.y;
  const values = outline.map(across);
  const lo = Math.min(...values), hi = Math.max(...values);
  // Edge joists sit a little inside the outline, so a wall drawn slightly out of square still holds them whole
  const edge = Math.min(spacing * 0.05, (hi - lo) / 4);
  const origin = across(start);
  const offsets: number[] = [lo + edge];
  for (let k = Math.ceil((lo - origin) / spacing); origin + k * spacing < hi; k++) {
    const c = origin + k * spacing;
    if (c > lo + spacing * 0.15 && c < hi - spacing * 0.15) offsets.push(c);
  }
  offsets.push(hi - edge);
  const rings = [outline, ...holes];
  const lines: [Pt, Pt][] = [];
  for (const c of offsets) {
    const hits: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const va = across(a), vb = across(b);
        if ((va > c) === (vb > c)) continue;
        const t = (c - va) / (vb - va);
        hits.push(along(a) + t * (along(b) - along(a)));
      }
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      if (hits[i + 1] - hits[i] < 1e-6) continue;
      const at = (u: number): Pt => ({ x: u * d.x + c * n.x, y: u * d.y + c * n.y });
      lines.push([at(hits[i]), at(hits[i + 1])]);
    }
  }
  return lines;
}

// Point where segment p1-p2 crosses segment q1-q2 (strictly inside p1-p2), or null
function crossing(p1: Pt, p2: Pt, q1: Pt, q2: Pt): Pt | null {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: q2.x - q1.x, y: q2.y - q1.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q1.x - p1.x) * s.y - (q1.y - p1.y) * s.x) / den;
  const u = ((q1.x - p1.x) * r.y - (q1.y - p1.y) * r.x) / den;
  if (t <= 1e-4 || t >= 1 - 1e-4 || u < 0 || u > 1) return null;
  return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}

function mid(a: Pt, b: Pt): Pt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// The double click repeats its point: drop corners on top of the previous one
function dedupe(points: Pt[]): Pt[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-6);
}
