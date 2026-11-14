import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  COLORS,
  LENGTH_UNITS,
  LINE_STYLES,
  LengthUnit,
  LineStyle,
  SCALE_GROUPS,
  isPresetScale,
  scaleName,
} from '../../models/takeoff';
import { DrawingStore } from '../../services/drawing.store';

// Right panel: takeoff value, selection, appearance, caption, document, page scale and viewports
// — port of PropertiesPanel.swift
@Component({
  selector: 'app-properties-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties' },
  template: `
    @let s = store.watch();
    @let measurements = s.selectedMeasurements;
    @let onlyMeasurements = measurements.length > 0 && measurements.length === s.selection.length;
    @let hasLines = hasKind(false);
    @let hasArea = hasKind(true);

    <!-- Big total of the selected measurements -->
    @if (s.takeoffValueText; as value) {
      <section class="panel-section">
        <div class="caption-label">TAKEOFF VALUE</div>
        <div class="takeoff-value">{{ value }}</div>
      </section>
    }

    @if (s.selection.length) {
      <!-- Selection: name, comment, visible, delete -->
      <section class="panel-section">
        <h3>Selection ({{ s.selection.length }})</h3>
        <label class="field"
          >Name
          <input [value]="s.selectionName" (change)="s.selectionName = value($event)" />
        </label>
        <!-- On measurements the PDF comment holds the quantity, so it isn't editable -->
        @if (s.selection.length === 1 && !onlyMeasurements) {
          <label class="field"
            >Comment
            <textarea
              rows="2"
              [value]="s.selectionContents"
              (change)="s.selectionContents = value($event)"
            ></textarea>
          </label>
        }
        <label class="check-field"
          ><input
            type="checkbox"
            [checked]="s.selectionVisible"
            (change)="s.selectionVisible = checked($event)"
          />
          Visible</label
        >
        <div class="row-buttons">
          <button (click)="s.selectElements([])">Deselect</button>
          <button class="destructive" (click)="s.deleteSelected()">Delete</button>
        </div>
      </section>

      <!-- Appearance: color, opacity, line width, style -->
      <section class="panel-section">
        <h3>Appearance</h3>
        <div class="field">
          Color
          <div class="swatches">
            @for (c of swatches; track c) {
              <button
                class="swatch-button"
                [style.background]="c"
                [title]="c"
                (click)="s.selectionColor = c"
              ></button>
            }
            <input
              type="color"
              [value]="s.selectionColor"
              (input)="s.selectionColor = value($event)"
            />
          </div>
        </div>
        @if (s.selectionHasFill) {
          <div class="field">
            Fill Color
            <div class="swatches">
              @for (c of swatches; track c) {
                <button
                  class="swatch-button"
                  [style.background]="c"
                  [title]="c"
                  (click)="s.selectionFillColor = c"
                ></button>
              }
              <input
                type="color"
                [value]="s.selectionFillColor"
                (input)="s.selectionFillColor = value($event)"
              />
            </div>
          </div>
        }
        @if (measurements.length) {
          <div class="field">
            Opacity
            <div class="slider-row">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                [value]="s.measureOpacity"
                (input)="s.measureOpacity = number($event)"
              />
              <span class="mono">{{ percent(s.measureOpacity) }} %</span>
            </div>
          </div>
        }
        @if (hasArea) {
          <div class="field">
            Fill Opacity
            <div class="slider-row">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                [value]="s.measureFillOpacity"
                (input)="s.measureFillOpacity = number($event)"
              />
              <span class="mono">{{ percent(s.measureFillOpacity) }} %</span>
            </div>
          </div>
        }
        @if (hasLines || !measurements.length) {
          <div class="field">
            Line Width
            <div class="slider-row">
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                [value]="s.selectionLineWidth"
                (input)="s.selectionLineWidth = number($event)"
              />
              <span class="mono">{{ s.selectionLineWidth.toFixed(1) }}</span>
            </div>
          </div>
        }
        @if (hasLines) {
          <div class="field">
            Style
            <div class="segmented">
              @for (style of lineStyles; track style) {
                <button [class.active]="s.measureLineStyle === style" (click)="setStyle(style)">
                  {{ style }}
                </button>
              }
            </div>
          </div>
          <label class="check-field"
            ><input
              type="checkbox"
              [checked]="s.measureArrows"
              (change)="s.measureArrows = checked($event)"
            />
            Arrows on Both Ends</label
          >
        }
        <!-- Unit of the measurement text (lengths and areas) -->
        @if (hasLines || hasArea) {
          <label class="field"
            >Length Unit
            <select (change)="setUnit($event)">
              @for (u of lengthUnits; track u) {
                <option [value]="u" [selected]="s.measureLengthUnit === u">{{ u }}</option>
              }
            </select>
          </label>
        }
      </section>

      <!-- Caption: measurement text on the plan (can be hidden) -->
      @if (measurements.length) {
        <section class="panel-section">
          <h3>Caption</h3>
          <label class="check-field"
            ><input
              type="checkbox"
              [checked]="s.captionVisible"
              (change)="s.captionVisible = checked($event)"
            />
            Show caption</label
          >
          @if (s.captionVisible) {
            <label class="field"
              >Font
              <select (change)="s.captionFontName = value($event)">
                @for (f of fonts; track f) {
                  <option [value]="f" [selected]="s.captionFontName === f">{{ f }}</option>
                }
              </select>
            </label>
            <div class="field">
              Font Size
              <div class="slider-row">
                <input
                  type="range"
                  min="4"
                  max="48"
                  step="1"
                  [value]="s.captionFontSize"
                  (input)="s.captionFontSize = number($event)"
                />
                <span class="mono">{{ s.captionFontSize }} pt</span>
              </div>
            </div>
            <div class="field">
              Text Color
              <div class="slider-row">
                <label class="check-field"
                  ><input
                    type="checkbox"
                    [checked]="s.captionUsesLineColor"
                    (change)="s.captionUsesLineColor = checked($event)"
                  />
                  Use line</label
                >
                <input
                  type="color"
                  [value]="s.captionColor"
                  [disabled]="s.captionUsesLineColor"
                  (input)="s.captionColor = value($event)"
                />
              </div>
            </div>
            <div class="field">
              Style
              <div class="segmented">
                <button [class.active]="s.captionBold" (click)="s.captionBold = !s.captionBold">
                  <b>B</b>
                </button>
                <button
                  [class.active]="s.captionItalic"
                  (click)="s.captionItalic = !s.captionItalic"
                >
                  <i>I</i>
                </button>
              </div>
            </div>
          }
        </section>
      }
    }

    <!-- Document -->
    <section class="panel-section">
      <h3>Document</h3>
      <div class="info-row">
        <span>File</span><span>{{ s.fileName }}</span>
      </div>
      <div class="info-row">
        <span>Pages</span><span>{{ s.pageCount }}</span>
      </div>
      <div class="info-row">
        <span>Current Page</span
        ><span>{{ s.hasDocument ? s.pageName(s.currentPageIndex) : '' }}</span>
      </div>
    </section>

    <!-- Page Scale (like Revu): empty until it is set, one per page -->
    <section class="panel-section">
      <h3>Page Scale</h3>
      <label class="field"
        >Scale
        <select [disabled]="!s.hasDocument" (change)="setScale($event)">
          <option value="" [selected]="s.scaleDenominator === null">Not Set</option>
          @for (group of scaleGroups; track group.title) {
            <optgroup [label]="group.title">
              @for (p of group.presets; track p.name) {
                <option [value]="p.denominator" [selected]="s.scaleDenominator === p.denominator">
                  {{ p.name }}
                </option>
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
        <button
          [disabled]="!s.hasDocument || s.scaleDenominator === null"
          (click)="s.applyScaleToAllPages()"
        >
          Add Scale to All Pages
        </button>
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
          <button class="icon-button" title="Delete Viewport" (click)="s.deleteViewport(v.id)">
            <span class="icon small">delete</span>
          </button>
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
        <button [disabled]="!s.hasDocument" (click)="s.startViewport()">
          <span class="icon small">add</span> Add Viewport
        </button>
      }
      <p class="secondary small">
        Measurements inside a viewport use its scale instead of the page scale.
      </p>
    </section>
  `,
})
export class PropertiesPanel {
  readonly store = inject(DrawingStore);
  // Quick colors (like the swatches of the Mac app)
  readonly swatches = [
    COLORS.red,
    COLORS.orange,
    COLORS.yellow,
    COLORS.green,
    COLORS.mint,
    COLORS.cyan,
    COLORS.blue,
    COLORS.indigo,
    COLORS.purple,
    COLORS.pink,
    COLORS.brown,
    COLORS.gray,
    COLORS.black,
  ];
  readonly fonts = ['System', 'Helvetica', 'Arial', 'Menlo', 'Times New Roman'];
  readonly lineStyles = LINE_STYLES;
  readonly lengthUnits = LENGTH_UNITS;
  readonly scaleGroups = SCALE_GROUPS;

  hasKind(area: boolean): boolean {
    return this.store.selectedMeasurements.some((m) =>
      area ? m.kind === 'area' : m.kind !== 'count',
    );
  }

  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
  number(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }
  checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
  percent(v: number): number {
    return Math.round(v * 100);
  }
  isPreset(d: number): boolean {
    return isPresetScale(d);
  }
  name(d: number): string {
    return scaleName(d);
  }

  setStyle(style: LineStyle): void {
    this.store.measureLineStyle = style;
  }
  setUnit(e: Event): void {
    this.store.measureLengthUnit = this.value(e) as LengthUnit;
  }

  setScale(e: Event): void {
    const v = this.value(e);
    this.store.scaleDenominator = v === '' ? null : Number(v);
  }
}
