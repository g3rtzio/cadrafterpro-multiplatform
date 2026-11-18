import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Pt } from '../../models/takeoff';
import { CalcTools } from '../calc-tools/calc-tools';
import { DrawingStore } from '../drawing.store/drawing.store';
import { MarkupTools } from '../markup-tools/markup-tools';
import { TextSelect } from '../text-select/text-select';

// Cut Out (Home > Takeoff, like PlanSwift): click the corners of a hole inside an area; a double
// click, Enter or a click on the first corner closes it. The hole is cut out of the area around it
// (the selected one wins) and its size is taken off the area. The tool stays on for more holes;
// Esc drops the hole being drawn, a second Esc leaves the tool. Undo removes a hole.
@Injectable({ providedIn: 'root' })
export class CutoutTool {
  private readonly store = inject(DrawingStore);
  private readonly markups = inject(MarkupTools);
  private readonly textSelect = inject(TextSelect);
  private readonly calc = inject(CalcTools);

  readonly active = signal(false);
  readonly current = signal<{ pageIndex: number; points: Pt[] } | null>(null);

  constructor() {
    // A takeoff, markup or calculation tool, Select Text, another tab or closing the drawing ends it
    effect(() => {
      const s = this.store.watch();
      const stop = s.tool !== 'none' || s.ribbonTab !== 'Home' || !s.hasDocument || s.drawingViewport
        || !!this.markups.tool() || this.textSelect.active() || !!this.calc.mode() || s.snapshotMode !== 'none';
      untracked(() => { if (stop && this.active()) this.stop(); });
    });
  }

  toggle(): void {
    if (this.active()) return this.stop();
    if (!this.store.hasDocument) return;
    this.markups.cancel();
    this.textSelect.stop();
    this.calc.stop();
    this.store.cancelTool();
    this.current.set(null);
    this.active.set(true);
  }

  stop(): void {
    this.active.set(false);
    this.current.set(null);
  }

  // A click on the plan. closeDistance: how close (page units) to the first corner closes the hole
  addPoint(pageIndex: number, point: Pt, closeDistance: number): void {
    if (!this.active()) return;
    const now = this.current();
    const points = now && now.pageIndex === pageIndex ? now.points : [];
    const first = points[0];
    if (points.length >= 3 && first && Math.hypot(point.x - first.x, point.y - first.y) <= closeDistance) {
      this.finish();
      return;
    }
    this.current.set({ pageIndex, points: [...points, point] });
  }

  // Double click / Enter: the hole is closed and cut out of the area under it
  finish(): void {
    const now = this.current();
    if (!now) return;
    const points = dedupe(now.points);
    if (points.length < 3) {
      this.store.showToast('A cut out needs at least 3 corners.', true);
      return;
    }
    this.current.set(null);
    if (!this.store.addCutout(now.pageIndex, points)) {
      this.store.showToast('Draw the cut out inside an area measurement.', true);
    }
  }

  // Esc: drops the hole being drawn; with none, leaves the tool. Backspace: removes the last corner.
  escape(): void {
    if (this.current()) this.current.set(null);
    else this.stop();
  }

  undoPoint(): void {
    const now = this.current();
    if (!now) return;
    this.current.set(now.points.length > 1 ? { ...now, points: now.points.slice(0, -1) } : null);
  }
}

// The double click repeats its point: drop corners on top of the previous one
function dedupe(points: Pt[]): Pt[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-6);
}
