import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { JoistSettings, JoistTool } from '../../services/joist-tool/joist-tool';
import { Icon } from '../icon/icon';

// Joist Tool panel (like PlanSwift's Joist Tool properties and toolbar). It floats in the top-right
// corner of the plan while the tool is on: the settings of the joists, what the next clicks do,
// and Draw / Clear / Regenerate / Split for the joist area.
@Component({
  selector: 'app-joist-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'joist-panel',
    '(mousedown)': '$event.stopPropagation()',
    '(wheel)': '$event.stopPropagation()',
    '(dblclick)': '$event.stopPropagation()',
    '(keydown)': '$event.stopPropagation()',
  },
  styles: [`
    :host {
      position: absolute; top: 10px; right: 10px; z-index: 15; width: 280px;
      display: flex; flex-direction: column; gap: 7px; padding: 10px 12px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3); cursor: default; user-select: none;
    }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .head .spacer { flex: 1; }
    .row { display: grid; grid-template-columns: 104px 1fr; align-items: center; gap: 6px; }
    .row input[type=text], .row input[type=number] { min-width: 0; width: 100%; box-sizing: border-box; }
    .unit { display: flex; align-items: center; gap: 4px; }
    .unit input { flex: 1; }
    .check { display: flex; align-items: center; gap: 6px; }
    .step {
      font-size: 12px; padding: 6px 8px; border-radius: 6px;
      background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text);
    }
    .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
    .buttons button { display: flex; align-items: center; justify-content: center; gap: 4px; }
    .buttons button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .totals { font-size: 12px; color: var(--secondary); display: flex; justify-content: space-between; }
  `],
  template: `
    @let s = joist.settings();
    <div class="head">
      <app-icon class="icon small" [name]="grid() ? 'grid_on' : 'view_column'" /> {{ grid() ? 'Grid Tool' : 'Joist Tool' }}
      <span class="spacer"></span>
      <button class="icon-button" [title]="grid() ? 'Close the Grid Tool' : 'Close the Joist Tool'" (click)="joist.close()"><app-icon class="icon small" name="close" /></button>
    </div>

    <div class="step">{{ stepText() }}</div>

    <label class="row">Name
      <input type="text" [value]="s.name" (change)="set({ name: text($event) })" />
    </label>
    <label class="row">{{ grid() ? 'Line Type' : 'Joist Type' }}
      <input type="text" [value]="s.joistType" (change)="set({ joistType: text($event) })" />
    </label>
    @if (grid()) {
      <label class="row"><span class="check"><input type="checkbox" [checked]="s.along" (change)="set({ along: checked($event) })" /> Horizontal</span>
        <span class="unit"><input type="number" min="1" step="1" [value]="s.spacing" [disabled]="!s.along" (change)="set({ spacing: num($event, 24) })" /> in O.C.</span>
      </label>
      <label class="row"><span class="check"><input type="checkbox" [checked]="s.across" (change)="set({ across: checked($event) })" /> Vertical</span>
        <span class="unit"><input type="number" min="1" step="1" [value]="s.crossSpacing" [disabled]="!s.across" (change)="set({ crossSpacing: num($event, 24) })" /> in O.C.</span>
      </label>
    } @else {
      <label class="row">O.C. Spacing
        <span class="unit"><input type="number" min="1" step="1" [value]="s.spacing" (change)="set({ spacing: num($event, 16) })" /> in</span>
      </label>
    }
    <label class="row">Pitch
      <span class="unit"><input type="number" min="0" step="0.5" [value]="s.pitch" (change)="set({ pitch: num($event, 0) })" /> /12</span>
    </label>
    <label class="row">Min Length
      <span class="unit"><input type="number" min="0" step="1" [value]="s.minLength" (change)="set({ minLength: num($event, 0) })" /> in</span>
    </label>
    <label class="row">Color
      <input type="color" [value]="s.color" (change)="set({ color: text($event) })" />
    </label>
    <label class="check">
      <input type="checkbox" [checked]="s.showLabels" (change)="set({ showLabels: checked($event) })" /> Show labels on the {{ grid() ? 'lines' : 'joists' }}
    </label>

    @if (totals(); as t) {
      <div class="totals"><span>{{ t.count }} {{ grid() ? 'lines' : 'joists' }}</span><span>{{ t.length }}</span></div>
    }

    <div class="buttons">
      <button [class.on]="joist.mode() === 'area'" title="Draw a new joist area" (click)="joist.begin('area')">
        <app-icon class="icon small" name="pentagon" /> New Area
      </button>
      <button [class.on]="joist.mode() === 'direction'" [disabled]="!joist.area()"
              [title]="grid() ? 'Click two points along the horizontal lines to turn the grid' : 'Click the start and the end of the joist direction'"
              (click)="joist.begin('direction')">
        <app-icon class="icon small" [name]="grid() ? 'grid_on' : 'view_column'" /> {{ grid() ? 'Turn Grid' : 'Draw Joists' }}
      </button>
      <button [disabled]="!joist.area()" title="Draw the joists again with these settings" (click)="joist.regenerate()">
        <app-icon class="icon small" name="refresh" /> Regenerate
      </button>
      <button [disabled]="!totals()" [title]="grid() ? 'Remove the grid lines of this area' : 'Remove the joists of this area'" (click)="joist.clear()">
        <app-icon class="icon small" name="delete" /> {{ grid() ? 'Clear Grid' : 'Clear Joists' }}
      </button>
      <button [class.on]="joist.mode() === 'split'" [disabled]="!totals()" [title]="grid() ? 'Click two points: the lines crossed by that line are cut in two' : 'Click two points: the joists crossed by that line are cut in two'"
              (click)="joist.begin('split')">
        <app-icon class="icon small" name="content_cut" /> {{ grid() ? 'Split Lines' : 'Split Joists' }}
      </button>
      <button [title]="grid() ? 'Leave the Grid Tool' : 'Leave the Joist Tool'" (click)="joist.close()">
        <app-icon class="icon small" name="check" /> Done
      </button>
    </div>
  `,
})
export class JoistPanel {
  readonly joist = inject(JoistTool);
  private readonly store = inject(DrawingStore);

  readonly grid = computed(() => this.joist.kind() === 'grid');

  readonly stepText = computed(() => {
    this.store.watch();
    const now = this.joist.current();
    const grid = this.grid();
    switch (this.joist.mode()) {
      case 'area':
        if (now) return 'Click the next corner. Double click or Enter closes the area.';
        return grid ? 'Click the corners of the grid area. Horizontal and vertical lines fill it when it closes.' : '1. Click the corners of the joist area.';
      case 'direction':
        if (grid) return now ? 'Click a second point along the horizontal lines.' : 'Click a point the grid starts from.';
        return now ? '3. Click the end point of the joist direction.' : '2. Click the start point of the joist direction.';
      case 'split': return now ? 'Click the end of the split line.' : 'Click the start of the split line.';
      default: return this.joist.area() ? 'Change the settings and press Regenerate, or click another area.' : 'Click an area, or New Area.';
    }
  });

  // Joists of the area and their total length
  readonly totals = computed(() => {
    const s = this.store.watch();
    const area = this.joist.area();
    this.joist.settings();
    if (!area) return null;
    const list = this.joist.joistsOf(area);
    if (!list.length) return null;
    const feet = list.reduce((sum, m) => sum + s.measuredValue(m), 0);
    return { count: list.length, length: `${feet.toFixed(2)} ft` };
  });

  set(change: Partial<JoistSettings>): void { this.joist.update(change); }
  text(e: Event): string { return (e.target as HTMLInputElement).value; }
  checked(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
  num(e: Event, fallback: number): number {
    const v = Number((e.target as HTMLInputElement).value);
    return isFinite(v) && v >= 0 ? v : fallback;
  }
}
