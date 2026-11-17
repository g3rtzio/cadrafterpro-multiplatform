import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AREA_UNITS, LENGTH_UNITS, LengthUnit, SCALE_GROUPS, areaUnitName, isPresetScale, lengthUnitName, scaleName } from '../../models/takeoff';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// Scale panel of the right side bar (like Revu's Measurements › Scale):
// page scale, viewports of the current page and the scale of every page
@Component({
  selector: 'app-scale-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties' },
  template: `
    @let s = store.watch();

    <!-- Page Scale (like Revu): empty until it is set, one per page -->
    <section class="panel-section">
      <h3>Page Scale</h3>
      <label class="field">Scale
        <select [disabled]="!s.hasDocument" (change)="setScale($event)">
          <option value="" [selected]="s.scaleDenominator === null">Not Set</option>
          @for (group of scaleGroups; track group.title) {
            <optgroup [label]="group.title">
              @for (p of group.presets; track p.name) {
                <option [value]="p.denominator" [selected]="s.scaleDenominator === p.denominator">{{ p.name }}</option>
              }
            </optgroup>
          }
          <!-- A custom scale or one read from the file ("1 in = 8.333 ft") -->
          @if (s.scaleDenominator !== null && !isPreset(s.scaleDenominator)) {
            <option [value]="s.scaleDenominator" selected>{{ name(s.scaleDenominator) }}</option>
          }
        </select>
      </label>
      <div class="row-buttons">
        <button [disabled]="!s.hasDocument" (click)="s.requestPageScale()">Custom…</button>
        <button [disabled]="!s.hasDocument || s.scaleDenominator === null" (click)="s.applyScaleToAllPages()">Add Scale to All Pages</button>
      </div>
    </section>

    <!-- Viewports: parts of the page with their own scale -->
    <section class="panel-section">
      <h3>Viewports</h3>
      @for (v of s.currentViewports; track v.id) {
        <div class="viewport-row">
          <div>
            <div>{{ v.name }}</div>
            <div class="secondary small">{{ name(v.denominator) }}</div>
          </div>
          <span class="spacer"></span>
          <button (click)="s.editViewport(v.id)">Edit</button>
          <button class="icon-button" title="Delete Viewport" (click)="s.deleteViewport(v.id)"><app-icon class="icon small" name="delete" /></button>
        </div>
      } @empty {
        <div class="secondary">No viewports on this page</div>
      }
      @if (s.drawingViewport) {
        <div class="viewport-row">
          <span class="secondary">Drag a box on the plan…</span>
          <span class="spacer"></span>
          <button (click)="s.cancelViewport()">Cancel</button>
        </div>
      } @else {
        <button [disabled]="!s.hasDocument" (click)="s.startViewport()"><app-icon class="icon small" name="add" /> Add Viewport</button>
      }
      <p class="secondary small">Measurements inside a viewport use its scale instead of the page scale.</p>
    </section>

    <!-- Units of measure: lengths (ft-in, ft, in, mm, m…) and areas (sf, sy, m²…) -->
    <section class="panel-section">
      <h3>Units</h3>
      <label class="field">Length Unit
        <select (change)="unit.set(unitOf($event))">
          @for (u of lengthUnits; track u) {
            <option [value]="u" [selected]="unit() === u">{{ unitName(u) }}</option>
          }
        </select>
      </label>
      <label class="field">Area Unit
        <select (change)="areaUnit.set(unitOf($event))">
          @for (u of areaUnits; track u) {
            <option [value]="u" [selected]="areaUnit() === u">{{ areaName(u) }}</option>
          }
        </select>
      </label>
      <div class="row-buttons">
        <button (click)="useForNew()">Use for New Measurements</button>
        <button [disabled]="!s.hasDocument" (click)="s.applyUnitsToAll(unit(), areaUnit())">Apply to All</button>
      </div>
      <p class="secondary small">New lengths use {{ unitName(s.defaultLengthUnit) }}; new areas use {{ areaName(s.defaultAreaUnit) }}. To change only some measurements, select them and use Properties.</p>
    </section>

    <!-- Scale of every page: click a page to go to it -->
    @if (s.hasDocument) {
      <section class="panel-section">
        <h3>All Pages</h3>
        @for (i of pageIndexes(); track i) {
          <button class="page-scale-row" [class.current]="i === s.currentPageIndex" (click)="s.goTo(i)">
            <span class="page-name">{{ s.pageName(i) }}</span>
            <span class="secondary">{{ pageScale(i) }}</span>
          </button>
        }
      </section>
    }
  `,
  styles: [`
    .page-scale-row {
      display: flex;
      gap: 8px;
      width: 100%;
      border: none;
      background: transparent;
      text-align: left;
      padding: 3px 6px;
      border-radius: 5px;
    }
    .page-scale-row.current { background: var(--accent-soft); font-weight: 600; }
    .page-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class ScalePanel {
  readonly store = inject(DrawingStore);
  readonly scaleGroups = SCALE_GROUPS;
  readonly lengthUnits = LENGTH_UNITS;
  readonly areaUnits = AREA_UNITS;
  readonly unit = signal<LengthUnit>(this.store.defaultLengthUnit);
  readonly areaUnit = signal<LengthUnit>(this.store.defaultAreaUnit);

  unitOf(e: Event): LengthUnit { return (e.target as HTMLSelectElement).value as LengthUnit; }

  unitName(u: LengthUnit): string { return lengthUnitName(u); }
  areaName(u: LengthUnit): string { return areaUnitName(u); }

  useForNew(): void {
    this.store.defaultLengthUnit = this.unit();
    this.store.defaultAreaUnit = this.areaUnit();
    this.store.touch();
  }

  isPreset(d: number): boolean { return isPresetScale(d); }
  name(d: number): string { return scaleName(d); }

  pageIndexes(): number[] {
    return Array.from({ length: this.store.pageCount }, (_, i) => i);
  }

  pageScale(i: number): string {
    const d = this.store.pageScales.get(i);
    return d === undefined ? 'Not Set' : scaleName(d);
  }

  setScale(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    this.store.scaleDenominator = v === '' ? null : Number(v);
  }
}
