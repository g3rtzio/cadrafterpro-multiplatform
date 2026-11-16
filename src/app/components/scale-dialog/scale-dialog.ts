import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SCALE_GROUPS, SCALE_UNITS, ScaleUnit, denominatorFor, isPresetScale } from '../../models/takeoff';
import { DrawingStore } from '../../services/drawing.store';

// Scale dialog (like Revu's "Page Scale" / "Apply Scale to Viewport"):
// a preset from the list, or a custom "1 in = 8.333 ft" — port of ScaleSheet.swift
@Component({
  selector: 'app-scale-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.cancelScaleRequest()' },
  template: `
    @let s = store.watch();
    <form class="dialog" (submit)="$event.preventDefault(); apply()">
      <h2>{{ s.scaleRequestTitle }}</h2>
      @if (s.scaleRequest?.pendingItemId) {
        <p class="secondary"><span class="icon small">straighten</span> This page has no scale yet. Set it to start measuring.</p>
      }
      @if (s.scaleRequestIsViewport) {
        <label class="field">Label <input [value]="name()" (input)="name.set(text($event))" /></label>
      }
      <div class="field">Scale
        <div class="radio-row">
          <label><input type="radio" name="mode" [checked]="usePreset()" (change)="usePreset.set(true)" /> Preset</label>
          <label><input type="radio" name="mode" [checked]="!usePreset()" (change)="usePreset.set(false)" /> Custom</label>
        </div>
      </div>
      @if (usePreset()) {
        <label class="field">Preset
          <select (change)="preset.set(+text($event))">
            @for (group of scaleGroups; track group.title) {
              <optgroup [label]="group.title">
                @for (p of group.presets; track p.name) {
                  <option [value]="p.denominator" [selected]="preset() === p.denominator">{{ p.name }}</option>
                }
              </optgroup>
            }
          </select>
        </label>
      } @else {
        <div class="field">Custom
          <div class="custom-row">
            <input type="number" step="any" min="0" class="num-input" [value]="paper()" (input)="paper.set(+text($event))" />
            <select (change)="paperUnit.set($any(text($event)))">
              @for (u of units; track u) { <option [value]="u" [selected]="paperUnit() === u">{{ u }}</option> }
            </select>
            <span>=</span>
            <input type="number" step="any" min="0" class="num-input" [value]="real()" (input)="real.set(+text($event))" />
            <select (change)="realUnit.set($any(text($event)))">
              @for (u of units; track u) { <option [value]="u" [selected]="realUnit() === u">{{ u }}</option> }
            </select>
          </div>
        </div>
      }
      <div class="dialog-buttons">
        <button type="button" (click)="s.cancelScaleRequest()">Cancel</button>
        <button type="submit" class="primary" [disabled]="denominator() === null">Apply</button>
      </div>
    </form>
  `,
})
export class ScaleDialog {
  readonly store = inject(DrawingStore);
  readonly scaleGroups = SCALE_GROUPS;
  readonly units = SCALE_UNITS;

  readonly name = signal('');
  readonly usePreset = signal(true);
  readonly preset = signal(48);
  readonly paper = signal(1);
  readonly paperUnit = signal<ScaleUnit>('in');
  readonly real = signal(4);
  readonly realUnit = signal<ScaleUnit>('ft');

  // Chosen scale as a denominator (1/4" = 1'-0" → 48)
  readonly denominator = computed(() => this.usePreset()
    ? this.preset()
    : denominatorFor(this.paper(), this.paperUnit(), this.real(), this.realUnit()));

  constructor() {
    // Starts with the current scale: a preset, or "1 in = x ft" for any other value
    const start = this.store.scaleRequestStart;
    this.name.set(start.name);
    const d = start.denominator;
    if (d === null) return;
    if (isPresetScale(d)) {
      this.usePreset.set(true);
      this.preset.set(d);
    } else {
      this.usePreset.set(false);
      this.paper.set(1);
      this.paperUnit.set('in');
      this.real.set(Math.round(d / 12 * 1000) / 1000);
      this.realUnit.set('ft');
    }
  }

  text(e: Event): string { return (e.target as HTMLInputElement).value; }

  apply(): void {
    const d = this.denominator();
    if (d !== null) this.store.applyScaleRequest(d, this.name());
  }
}
