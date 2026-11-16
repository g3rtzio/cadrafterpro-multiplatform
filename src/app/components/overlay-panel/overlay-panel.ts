import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DrawingStore, OverlayState } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

const COLORS = ['#FF3B30', '#007AFF', '#34C759', '#FF9500', '#AF52DE', '#000000'];

// Overlay controls (like Revu's Overlay Pages): which page goes underneath and which on top,
// the color of each one, and how the page on top is moved, scaled and rotated to line up.
// It floats in the top-right corner of the plan pane.
@Component({
  selector: 'app-overlay-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'overlay-panel',
    '(mousedown)': '$event.stopPropagation()',
    '(wheel)': '$event.stopPropagation()',
    '(dblclick)': '$event.stopPropagation()',
  },
  styles: [`
    :host {
      position: absolute; top: 10px; right: 10px; z-index: 15; width: 270px;
      display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3); cursor: default; user-select: none;
    }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .head .spacer { flex: 1; }
    .row { display: grid; grid-template-columns: 62px 1fr auto; align-items: center; gap: 6px; }
    .row select { min-width: 0; }
    .colors { display: flex; gap: 4px; align-items: center; }
    .chip { width: 16px; height: 16px; border-radius: 50%; padding: 0; border: 1px solid rgba(128, 128, 128, 0.5); }
    .chip.on { outline: 2px solid var(--accent); outline-offset: 1px; }
    .chip.none { background: linear-gradient(135deg, #fff 45%, #ff3b30 45%, #ff3b30 55%, #fff 55%); }
    .value { width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
    .buttons { display: flex; gap: 6px; flex-wrap: wrap; }
    .buttons button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .hint { font-size: 11px; color: var(--secondary); margin: 0; }
  `],
  template: `
    @let s = store.watch();
    @if (store.overlay(); as o) {
      <div class="head">
        <app-icon class="icon small" name="layers" /> Overlay Pages
        <span class="spacer"></span>
        <button class="icon-button" title="Close Overlay" (click)="store.closeOverlay()"><app-icon class="icon small" name="close" /></button>
      </div>

      <label class="row">Base
        <select (change)="update({ baseIndex: +value($event) })">
          @for (p of s.pages; track $index) {
            <option [value]="$index" [selected]="$index === o.baseIndex">{{ s.pageName($index) }}</option>
          }
        </select>
        <span></span>
      </label>
      <div class="row"><span></span>
        <div class="colors">
          <button class="chip none" title="Original colors" [class.on]="o.baseColor === null" (click)="update({ baseColor: null })"></button>
          @for (c of colors; track c) {
            <button class="chip" [style.background]="c" [class.on]="o.baseColor === c" (click)="update({ baseColor: c })"></button>
          }
          <input type="color" title="Other color" [value]="o.baseColor ?? '#000000'" (input)="update({ baseColor: value($event) })" />
        </div><span></span>
      </div>

      <label class="row">On top
        <select (change)="update({ sourceIndex: +value($event) })">
          @for (p of s.pages; track $index) {
            @if ($index !== o.baseIndex) {
              <option [value]="$index" [selected]="$index === o.sourceIndex">{{ s.pageName($index) }}</option>
            }
          }
        </select>
        <span></span>
      </label>
      <div class="row"><span></span>
        <div class="colors">
          @for (c of colors; track c) {
            <button class="chip" [style.background]="c" [class.on]="o.overlayColor === c" (click)="update({ overlayColor: c })"></button>
          }
          <input type="color" title="Other color" [value]="o.overlayColor" (input)="update({ overlayColor: value($event) })" />
        </div><span></span>
      </div>

      <label class="row">Opacity
        <input type="range" min="0.1" max="1" step="0.05" [value]="o.opacity" (input)="update({ opacity: +value($event) })" />
        <span class="value">{{ (o.opacity * 100).toFixed(0) }}%</span>
      </label>
      <label class="row">Scale
        <input type="range" min="0.5" max="2" step="0.001" [value]="o.scale" (input)="update({ scale: +value($event) })" />
        <input class="value" type="number" step="0.1" min="10" max="400" [value]="+(o.scale * 100).toFixed(1)"
               (change)="update({ scale: clamp(+value($event) / 100, 0.1, 4) })" />
      </label>
      <label class="row">Rotation
        <input type="range" min="-180" max="180" step="0.1" [value]="o.rotation" (input)="update({ rotation: +value($event) })" />
        <input class="value" type="number" step="0.1" min="-180" max="180" [value]="o.rotation"
               (change)="update({ rotation: clamp(+value($event), -180, 180) })" />
      </label>

      <div class="buttons">
        <button [class.on]="o.adjusting" title="Drag on the plan (or use the arrow keys) to line up the page on top"
                (click)="update({ adjusting: !o.adjusting })">
          <app-icon class="icon small" name="open_with" /> Move
        </button>
        <button title="Back to the original position" (click)="update({ dx: 0, dy: 0, scale: 1, rotation: 0 })">Reset</button>
        <button title="Swap the pages" (click)="swap(o)">Swap</button>
        @if (s.currentPageIndex !== o.baseIndex) {
          <button (click)="s.goTo(o.baseIndex)">Show</button>
        }
      </div>
      @if (o.adjusting) {
        <p class="hint">Drag on the plan to move the page on top. Arrows nudge it 1 px, Shift + arrows 10 px.</p>
      }
    }
  `,
})
export class OverlayPanel {
  readonly store = inject(DrawingStore);
  readonly colors = COLORS;

  update(change: Partial<OverlayState>): void {
    this.store.updateOverlay(change);
  }

  swap(o: OverlayState): void {
    this.store.updateOverlay({ baseIndex: o.sourceIndex, sourceIndex: o.baseIndex });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  clamp(v: number, min: number, max: number): number {
    return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : min;
  }
}
