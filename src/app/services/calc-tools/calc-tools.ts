import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Pt, quantityText } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { MarkupTools } from '../markup-tools/markup-tools';
import { PageGeometry } from '../pdf-render/pdf-render';
import { TextSelect } from '../text-select/text-select';

// Calculation tools of the Home tab (like PlanSwift's Calculations):
//   Pitch: click the start and the end of a sloped line (a rafter on a section or an elevation);
//          its pitch shows as rise per 12 of run, and it can be applied to roof areas and lines.
//   Triangulate: click three points; the triangle shows the length of each side (with the scale)
//          and the angle at each corner.
// What was measured stays on its page until the tool is turned off or cleared (it isn't saved).

export type CalcMode = 'pitch' | 'triangulate';

export interface CalcItem {
  kind: CalcMode;
  page: PageGeometry;
  points: Pt[];               // page coordinates
}

@Injectable({ providedIn: 'root' })
export class CalcTools {
  private readonly store = inject(DrawingStore);
  private readonly markups = inject(MarkupTools);
  private readonly textSelect = inject(TextSelect);

  readonly mode = signal<CalcMode | null>(null);
  readonly current = signal<{ page: PageGeometry; points: Pt[] } | null>(null);
  readonly items = signal<CalcItem[]>([]);

  constructor() {
    // A takeoff or markup tool, Select Text, another tab or closing the drawing ends it
    effect(() => {
      const s = this.store.watch();
      const stop = s.tool !== 'none' || s.ribbonTab !== 'Home' || !s.hasDocument || s.drawingViewport
        || !!this.markups.tool() || this.textSelect.active() || s.snapshotMode !== 'none';
      untracked(() => {
        if (stop && this.mode()) this.stop();
        if (!s.hasDocument && this.items().length) this.items.set([]);
      });
    });
  }

  start(mode: CalcMode): void {
    if (!this.store.hasDocument) return;
    if (this.mode() === mode) return this.stop();
    this.markups.cancel();
    this.textSelect.stop();
    this.store.cancelTool();
    this.store.selectElements([]);
    this.current.set(null);
    this.mode.set(mode);
  }

  stop(): void {
    this.mode.set(null);
    this.current.set(null);
  }

  clear(): void {
    this.items.set([]);
    this.current.set(null);
  }

  // A click on the plan: two points finish a pitch line, three a triangle
  addPoint(page: PageGeometry, point: Pt): void {
    const mode = this.mode();
    if (!mode) return;
    const now = this.current();
    const points = now && now.page === page ? [...now.points, point] : [point];
    const needed = mode === 'pitch' ? 2 : 3;
    if (points.length < needed) {
      this.current.set({ page, points });
      return;
    }
    this.current.set(null);
    this.items.update(list => [...list, { kind: mode, page, points }]);
  }

  // Escape: the points in progress go first, then the tool
  escape(): void {
    if (this.current()) this.current.set(null); else this.stop();
  }

  // MARK: - Values
  // Pitch of a line as seen on the sheet: rise per 12 of run
  pitchOf(page: PageGeometry, a: Pt, b: Pt): number {
    const va = page.toView(a), vb = page.toView(b);
    const run = Math.abs(vb.x - va.x), rise = Math.abs(vb.y - va.y);
    return run < 1e-6 ? Infinity : rise / run * 12;
  }

  pitchText(pitch: number): string {
    if (!isFinite(pitch)) return 'Vertical';
    const angle = Math.atan(pitch / 12) * 180 / Math.PI;
    return `${pitch.toFixed(1)}/12 · ${angle.toFixed(1)}°`;
  }

  // Length of a side with the scale of the page there ("35'-11 3/8\"")
  lengthText(page: PageGeometry, a: Pt, b: Pt): string {
    const index = this.store.pages.indexOf(page);
    const feet = Math.hypot(b.x - a.x, b.y - a.y) * this.store.feetPerPoint(Math.max(index, 0), a);
    return quantityText(feet, 'length', this.store.unitFor('length'));
  }

  // Angle at corner b (degrees) between b→a and b→c
  angleAt(a: Pt, b: Pt, c: Pt): number {
    const u = { x: a.x - b.x, y: a.y - b.y }, v = { x: c.x - b.x, y: c.y - b.y };
    const cos = (u.x * v.x + u.y * v.y) / ((Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }

  // The last pitch measured (offered in the Pitch window)
  lastPitch(): number | null {
    const last = [...this.items()].reverse().find(i => i.kind === 'pitch');
    if (!last) return null;
    const p = this.pitchOf(last.page, last.points[0], last.points[1]);
    return isFinite(p) ? Math.round(p * 100) / 100 : null;
  }
}
