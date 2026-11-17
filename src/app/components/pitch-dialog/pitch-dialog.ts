import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';

// Pitch (like PlanSwift's Calculations > Pitch): the roof slope of areas and lines. What is measured
// on the plan is flat; the pitch (rise in inches per 12 of run) gives the real sloped area or length.
// Hips and valleys run on the diagonal. Triangulate: the pitch from a rise and a run.
@Component({
  selector: 'app-pitch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.closePitch()' },
  template: `
    <form class="dialog pitch-dialog" (submit)="$event.preventDefault(); apply()">
      <h2>Pitch</h2>
      <div class="pitch-row">
        <label class="field">Pitch (rise per 12)
          <span class="pitch-input">
            <input type="number" min="0" max="48" step="0.5" class="num-input" [value]="pitch()"
                   (input)="pitch.set(number($event))" autofocus /> / 12
          </span>
        </label>
        <div class="pitch-presets">
          @for (p of presets; track p) {
            <button type="button" [class.active]="pitch() === p" (click)="pitch.set(p)">{{ p }}/12</button>
          }
        </div>
      </div>

      <fieldset class="pitch-box">
        <legend>Triangulate (pitch from a rise and a run)</legend>
        <label>Rise <input type="number" min="0" step="any" class="num-input" [value]="rise()" (input)="rise.set(number($event))" /></label>
        <label>Run <input type="number" min="0" step="any" class="num-input" [value]="run()" (input)="run.set(number($event))" /></label>
        <span class="secondary small">= {{ triangulated() }}/12 · {{ angle(triangulated()) }}°</span>
        <button type="button" [disabled]="!run()" (click)="pitch.set(triangulated())">Use</button>
      </fieldset>

      <div class="radio-row">
        <label><input type="radio" name="slope" [checked]="!hip()" (change)="hip.set(false)" /> Roof plane</label>
        <label><input type="radio" name="slope" [checked]="hip()" (change)="hip.set(true)" /> Hip or valley</label>
      </div>
      <p class="secondary small">Slope factor {{ factor().toFixed(4) }} · {{ angle(pitch()) }}° · 100 SF on the plan = {{ (100 * factor()).toFixed(2) }} SF sloped</p>

      <label class="check-row">
        <input type="checkbox" [checked]="useForQty()" (change)="useForQty.set($any($event.target).checked)" />
        Qty uses the sloped area or length
      </label>

      <div class="field">Apply to
        @if (elements().length === 0) {
          <p class="secondary small">There are no areas or lines yet. Measure one first.</p>
        } @else {
          <div class="pitch-list">
            @for (e of elements(); track e.name) {
              <label class="check-row">
                <input type="checkbox" [checked]="chosen().has(e.name)" (change)="toggle(e.name)" />
                <span class="pitch-name">{{ e.name }}</span>
                <span class="secondary small">{{ e.kind === 'area' ? 'Area' : 'Linear' }}{{ e.pitch ? ' · ' + e.pitch + '/12' + (e.hip ? ' hip' : '') : '' }}</span>
              </label>
            }
          </div>
        }
      </div>

      <div class="dialog-buttons">
        <button type="button" (click)="store.closePitch()">Cancel</button>
        <button type="submit" class="primary" [disabled]="chosen().size === 0 || pitch() < 0">
          Apply to {{ chosen().size }} item{{ chosen().size === 1 ? '' : 's' }}
        </button>
      </div>
    </form>
  `,
})
export class PitchDialog {
  readonly store = inject(DrawingStore);
  readonly presets = [3, 4, 5, 6, 8, 10, 12];
  readonly elements = signal(this.store.slopeElements());
  // Picked: what is selected; with nothing selected and a single area or line, that one
  readonly chosen = signal(new Set(this.store.slopeTargets().length ? this.store.slopeTargets()
    : this.elements().length === 1 ? [this.elements()[0].name] : []));

  // Starts from the pitch of the first item picked
  private readonly first = this.elements().find(e => this.chosen().has(e.name));
  readonly pitch = signal(this.store.pitchSeed ?? (this.first?.pitch || 4));
  readonly hip = signal(this.first?.hip ?? false);
  readonly useForQty = signal(this.first ? this.first.sloped || !this.first.pitch : true);
  readonly rise = signal(0);
  readonly run = signal(12);

  readonly factor = computed(() => {
    const r = this.pitch() / 12;
    return this.hip() ? Math.sqrt(1 + (this.pitch() * this.pitch()) / 288) : Math.sqrt(1 + r * r);
  });

  readonly triangulated = computed(() => this.run() ? Math.round(this.rise() / this.run() * 12 * 100) / 100 : 0);

  angle(pitch: number): string {
    return (Math.atan(pitch / 12) * 180 / Math.PI).toFixed(1);
  }

  number(event: Event): number {
    return Number((event.target as HTMLInputElement).value) || 0;
  }

  toggle(name: string): void {
    this.chosen.update(set => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  apply(): void {
    this.store.applyPitch([...this.chosen()], this.pitch(), this.hip(), this.useForQty());
  }
}
