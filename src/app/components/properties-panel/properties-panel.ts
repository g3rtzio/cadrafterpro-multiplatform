import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Markup } from '../../models/elements';
import { AREA_UNITS, COLORS, LENGTH_UNITS, LINE_STYLES, LengthUnit, LineStyle, areaUnitName, lengthUnitName } from '../../models/takeoff';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { MarkupStyle, MarkupTools, SHAPE_FILL_OPACITY } from '../../services/markup-tools/markup-tools';

// Settings panel of the right side bar: takeoff value, selection, appearance, caption,
// markup text and arrows, the look of the active markup tool, and the document
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
    @let hasLinear = hasLinearKind();
    @let marks = markups.selectedMarkups;
    @let first = marks[0];
    @let tool = markups.tool();

    <!-- Active markup tool: the look of the next markup (remembered per tool) -->
    @if (tool && !s.selection.length) {
      @let st = toolStyle();
      <section class="panel-section">
        <h3>{{ markups.info(tool).title }}</h3>
        <p class="secondary small">{{ markups.info(tool).hint }}</p>
        <div class="field">Color
          <div class="swatches">
            @for (c of swatches; track c) {
              <button class="swatch-button" [style.background]="c" [title]="c" (click)="setTool({ color: c })"></button>
            }
            <input type="color" [value]="st.color" (input)="setTool({ color: value($event) })" />
          </div>
        </div>
        @if (tool !== 'line' && tool !== 'arrow' && tool !== 'polyline' && tool !== 'pen' && tool !== 'highlight') {
          <div class="field">Fill Color
            <div class="slider-row">
              <label class="check-field"><input type="checkbox" [checked]="st.fillColor !== null"
                     (change)="setToolFill(checked($event))" /> Fill</label>
              <input type="color" [value]="st.fillColor ?? '#FFFFFF'" [disabled]="st.fillColor === null"
                     (input)="setTool({ fillColor: value($event) })" />
            </div>
          </div>
          @if (st.fillColor !== null) {
            <div class="field">Fill Opacity
              <div class="slider-row">
                <input type="range" min="0.05" max="1" step="0.05" [value]="st.fillOpacity"
                       (input)="setTool({ fillOpacity: number($event) })" />
                <span class="mono">{{ percent(st.fillOpacity) }} %</span>
              </div>
            </div>
          }
        }
        <div class="field">Line Width
          <div class="slider-row">
            <input type="range" min="0" [max]="tool === 'highlight' ? 30 : 10" step="0.5" [value]="st.lineWidth"
                   (input)="setTool({ lineWidth: number($event) })" />
            <span class="mono">{{ st.lineWidth.toFixed(1) }}</span>
          </div>
        </div>
        <div class="field">Opacity
          <div class="slider-row">
            <input type="range" min="0.05" max="1" step="0.05" [value]="st.opacity" (input)="setTool({ opacity: number($event) })" />
            <span class="mono">{{ percent(st.opacity) }} %</span>
          </div>
        </div>
        @if (tool === 'text' || tool === 'callout') {
          <div class="field">Font Size
            <div class="slider-row">
              <input type="range" min="4" max="72" step="1" [value]="st.fontSize" (input)="setTool({ fontSize: number($event) })" />
              <span class="mono">{{ st.fontSize }} pt</span>
            </div>
          </div>
          <label class="field">Text Color
            <input type="color" [value]="st.textColor" (input)="setTool({ textColor: value($event) })" />
          </label>
        }
      </section>
    }

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
        <label class="field">Name
          <input [value]="s.selectionName" (change)="s.selectionName = value($event)" />
        </label>
        <!-- On measurements the PDF comment holds the quantity, so it isn't editable -->
        @if (s.selection.length === 1 && !onlyMeasurements && !first?.isTextBox) {
          <label class="field">Comment
            <textarea rows="2" [value]="s.selectionContents" (change)="s.selectionContents = value($event)"></textarea>
          </label>
        }
        <label class="check-field"><input type="checkbox" [checked]="s.selectionVisible"
               (change)="s.selectionVisible = checked($event)" /> Visible</label>
        <div class="row-buttons">
          <button (click)="s.selectElements([])">Deselect</button>
          <button class="destructive" (click)="s.deleteSelected()">Delete</button>
        </div>
      </section>

      <!-- Appearance: color, opacity, line width, style -->
      <section class="panel-section">
        <h3>Appearance</h3>
        <div class="field">Color
          <div class="swatches">
            @for (c of swatches; track c) {
              <button class="swatch-button" [style.background]="c" [title]="c" (click)="s.selectionColor = c"></button>
            }
            <input type="color" [value]="s.selectionColor" (input)="s.selectionColor = value($event)" />
          </div>
        </div>
        @if (s.selectionHasFill) {
          <div class="field">Fill Color
            <div class="swatches">
              @for (c of swatches; track c) {
                <button class="swatch-button" [style.background]="c" [title]="c" (click)="s.selectionFillColor = c"></button>
              }
              <input type="color" [value]="s.selectionFillColor" (input)="s.selectionFillColor = value($event)" />
            </div>
          </div>
        }
        @if (measurements.length) {
          <div class="field">Opacity
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.01" [value]="s.measureOpacity" (input)="s.measureOpacity = number($event)" />
              <span class="mono">{{ percent(s.measureOpacity) }} %</span>
            </div>
          </div>
        }
        @if (hasArea) {
          <div class="field">Fill Opacity
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.01" [value]="s.measureFillOpacity" (input)="s.measureFillOpacity = number($event)" />
              <span class="mono">{{ percent(s.measureFillOpacity) }} %</span>
            </div>
          </div>
        }
        @if (hasLines || !measurements.length) {
          <div class="field">Line Width
            <div class="slider-row">
              <input type="range" min="0" max="10" step="0.5" [value]="s.selectionLineWidth" (input)="s.selectionLineWidth = number($event)" />
              <span class="mono">{{ s.selectionLineWidth.toFixed(1) }}</span>
            </div>
          </div>
        }
        @if (hasLines) {
          <div class="field">Style
            <div class="segmented">
              @for (style of lineStyles; track style) {
                <button [class.active]="s.measureLineStyle === style" (click)="setStyle(style)">{{ style }}</button>
              }
            </div>
          </div>
          @if (hasLinear) {
            <label class="check-field"><input type="checkbox" [checked]="s.measureArrows"
                   (change)="s.measureArrows = checked($event)" /> Arrows on Both Ends</label>
          }
        }
        <!-- Unit of the measurement text: lengths in length units, areas in area units -->
        @if (hasLinear) {
          <label class="field">Length Unit
            <select (change)="setUnit($event)">
              @for (u of lengthUnits; track u) {
                <option [value]="u" [selected]="s.measureLengthUnit === u">{{ lengthName(u) }}</option>
              }
            </select>
          </label>
        }
        @if (hasArea) {
          <label class="field">Area Unit
            <select (change)="setAreaUnit($event)">
              @for (u of areaUnits; track u) {
                <option [value]="u" [selected]="s.measureAreaUnit === u">{{ areaName(u) }}</option>
              }
            </select>
          </label>
        }
      </section>

      <!-- Markups (text boxes, callouts, clouds, lines…): text, font, opacity, arrows, cloud -->
      @if (first) {
        <section class="panel-section">
          <h3>Markup</h3>
          @if (marks.length === 1 && first.isTextBox) {
            <label class="field">Text
              <textarea rows="3" [value]="first.contents" (change)="setText(first, value($event))"></textarea>
            </label>
          }
          <div class="field">Opacity
            <div class="slider-row">
              <input type="range" min="0.05" max="1" step="0.05" [value]="first.opacity"
                     (input)="setField('opacity', number($event))" />
              <span class="mono">{{ percent(first.opacity) }} %</span>
            </div>
          </div>
          @if (!first.isTextBox && first.subtype !== 'Ink') {
            <label class="check-field"><input type="checkbox" [checked]="first.dashed"
                   (change)="setField('dashed', checked($event))" /> Dashed Line</label>
          }
          @if (first.fillColor === null && hasFillShape(marks)) {
            <button (click)="setFill(true)">Add Fill</button>
          } @else if (first.fillColor !== null && hasFillShape(marks)) {
            <div class="field">Fill Opacity
              <div class="slider-row">
                <input type="range" min="0.05" max="1" step="0.05" [value]="first.fillOpacity ?? 1"
                       (input)="setFillOpacity(number($event))" />
                <span class="mono">{{ percent(first.fillOpacity ?? 1) }} %</span>
              </div>
            </div>
            <button (click)="setFill(false)">Remove Fill</button>
          }
          @if (first.isTextBox) {
            <div class="field">Font Size
              <div class="slider-row">
                <input type="range" min="4" max="72" step="1" [value]="first.fontSize"
                       (input)="setField('fontSize', number($event))" />
                <span class="mono">{{ first.fontSize }} pt</span>
              </div>
            </div>
            <label class="field">Text Color
              <input type="color" [value]="first.textColor ?? '#000000'"
                     (input)="setField('textColor', value($event))" />
            </label>
          }
          @if (first.subtype === 'Polygon' && !first.isRevuMeasurement) {
            <label class="check-field"><input type="checkbox" [checked]="first.cloud > 0"
                   (change)="setField('cloud', checked($event) ? 1 : 0)" /> Cloud</label>
          }
          @if (first.subtype === 'Line' || (first.subtype === 'PolyLine' && !first.isRevuMeasurement) || first.callout) {
            <div class="field">{{ first.callout ? 'Arrow' : 'Line Ends' }}
              <div class="slider-row">
                <select (change)="setEnd(0, value($event))">
                  @for (e of lineEnds; track e) { <option [value]="e" [selected]="end(first, 0) === e">{{ e }}</option> }
                </select>
                @if (!first.callout) {
                  <select (change)="setEnd(1, value($event))">
                    @for (e of lineEnds; track e) { <option [value]="e" [selected]="end(first, 1) === e">{{ e }}</option> }
                  </select>
                }
              </div>
            </div>
          }
        </section>
      }

      <!-- Caption: measurement text on the plan (can be hidden) -->
      @if (measurements.length) {
        <section class="panel-section">
          <h3>Caption</h3>
          <label class="check-field"><input type="checkbox" [checked]="s.captionVisible"
                 (change)="s.captionVisible = checked($event)" /> Show caption</label>
          @if (s.captionVisible) {
            <label class="field">Font
              <select (change)="s.captionFontName = value($event)">
                @for (f of fonts; track f) {
                  <option [value]="f" [selected]="s.captionFontName === f">{{ f }}</option>
                }
              </select>
            </label>
            <div class="field">Font Size
              <div class="slider-row">
                <input type="range" min="4" max="48" step="1" [value]="s.captionFontSize" (input)="s.captionFontSize = number($event)" />
                <span class="mono">{{ s.captionFontSize }} pt</span>
              </div>
            </div>
            <div class="field">Text Color
              <div class="slider-row">
                <label class="check-field"><input type="checkbox" [checked]="s.captionUsesLineColor"
                       (change)="s.captionUsesLineColor = checked($event)" /> Use line</label>
                <input type="color" [value]="s.captionColor" [disabled]="s.captionUsesLineColor"
                       (input)="s.captionColor = value($event)" />
              </div>
            </div>
            <div class="field">Style
              <div class="segmented">
                <button [class.active]="s.captionBold" (click)="s.captionBold = !s.captionBold"><b>B</b></button>
                <button [class.active]="s.captionItalic" (click)="s.captionItalic = !s.captionItalic"><i>I</i></button>
              </div>
            </div>
          }
        </section>
      }
    }

    <!-- Document -->
    <section class="panel-section">
      <h3>Document</h3>
      <div class="info-row"><span>File</span><span>{{ s.fileName }}</span></div>
      <div class="info-row"><span>Pages</span><span>{{ s.pageCount }}</span></div>
      <div class="info-row"><span>Current Page</span><span>{{ s.hasDocument ? s.pageName(s.currentPageIndex) : '' }}</span></div>
    </section>

    <!-- Page Scale and Viewports live in the Scale panel of the side bar -->
  `,
})
export class PropertiesPanel {
  readonly store = inject(DrawingStore);
  readonly markups = inject(MarkupTools);
  readonly lineEnds = ['None', 'OpenArrow', 'ClosedArrow'];
  // Quick colors (like the swatches of the Mac app)
  readonly swatches = [COLORS.red, COLORS.orange, COLORS.yellow, COLORS.green, COLORS.mint, COLORS.cyan,
    COLORS.blue, COLORS.indigo, COLORS.purple, COLORS.pink, COLORS.brown, COLORS.gray, COLORS.black];
  readonly fonts = ['System', 'Helvetica', 'Arial', 'Menlo', 'Times New Roman'];
  readonly lineStyles = LINE_STYLES;
  readonly lengthUnits = LENGTH_UNITS;
  readonly areaUnits = AREA_UNITS;

  // Lengths and segments (not areas or counts) are selected
  hasLinearKind(): boolean {
    return this.store.selectedMeasurements.some(m => m.kind === 'length' || m.kind === 'segment');
  }

  hasKind(area: boolean): boolean {
    return this.store.selectedMeasurements.some(m => area ? m.kind === 'area' : m.kind !== 'count');
  }

  value(e: Event): string { return (e.target as HTMLInputElement).value; }
  number(e: Event): number { return Number((e.target as HTMLInputElement).value); }
  checked(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
  percent(v: number): number { return Math.round(v * 100); }

  setStyle(style: LineStyle): void { this.store.measureLineStyle = style; }
  setUnit(e: Event): void { this.store.measureLengthUnit = this.value(e) as LengthUnit; }
  setAreaUnit(e: Event): void { this.store.measureAreaUnit = this.value(e) as LengthUnit; }
  lengthName(u: LengthUnit): string { return lengthUnitName(u); }
  areaName(u: LengthUnit): string { return areaUnitName(u); }

  // MARK: - Markups
  toolStyle(): MarkupStyle {
    this.markups.styleVersion();
    return this.markups.style(this.markups.tool()!);
  }

  setTool(change: Partial<MarkupStyle>): void {
    const tool = this.markups.tool();
    if (tool) this.markups.setStyle(tool, change);
  }

  // One field of every selected markup (one Undo step while a slider moves)
  setField<K extends 'opacity' | 'dashed' | 'fontSize' | 'textColor' | 'cloud'>(key: K, v: Markup[K]): void {
    this.markups.edit(key, m => { m[key] = v; });
  }

  // Fill checkbox of the active tool: text boxes get an opaque white background,
  // shapes and clouds a see-through fill in their line color
  setToolFill(on: boolean): void {
    const tool = this.markups.tool();
    if (!tool) return;
    const text = tool === 'text' || tool === 'callout';
    const st = this.markups.style(tool);
    this.setTool(on
      ? { fillColor: text ? '#FFFFFF' : st.color, fillOpacity: text ? 1 : SHAPE_FILL_OPACITY }
      : { fillColor: null });
  }

  // Add Fill / Remove Fill of the selected markups (same defaults as the tool's Fill checkbox)
  setFill(on: boolean): void {
    this.markups.edit('fill', m => {
      if (!this.hasFillShape([m])) return;
      m.fillColor = on ? (m.isTextBox ? '#FFFFFF' : m.color ?? COLORS.red) : null;
      m.fillOpacity = on ? (m.isTextBox ? 1 : SHAPE_FILL_OPACITY) : null;
      m.redrawAppearance = true;
    });
  }

  // Fill opacity of the selected markups (one Undo step while the slider moves)
  setFillOpacity(v: number): void {
    this.markups.edit('fillOpacity', m => {
      if (!this.hasFillShape([m]) || m.fillColor === null) return;
      m.fillOpacity = v;
      m.redrawAppearance = true;
    });
  }

  setText(m: Markup, text: string): void {
    this.markups.startEditing(m);
    this.markups.commitText(m, text, this.store.pages[m.pageIndex] ?? null);
  }

  hasFillShape(list: Markup[]): boolean {
    return list.some(m => ['Square', 'Circle', 'Polygon', 'FreeText'].includes(m.subtype) && !m.isRevuMeasurement);
  }

  end(m: Markup, i: number): string {
    return m.lineEnds?.[i] ?? (m.callout && i === 0 ? 'OpenArrow' : 'None');
  }

  setEnd(i: number, style: string): void {
    this.markups.edit('ends', m => {
      const ends = [this.end(m, 0), this.end(m, 1)];
      ends[i] = style;
      m.lineEnds = m.callout ? [ends[0]] : ends;
    });
  }
}
