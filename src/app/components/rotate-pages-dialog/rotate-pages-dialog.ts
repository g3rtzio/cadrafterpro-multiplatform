import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';

// Batch Rotate Pages: turn many pages at once (all, the current one or a range such as "1-3, 7")
@Component({
  selector: 'app-rotate-pages-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.closeBatchRotate()' },
  template: `
    @let s = store.watch();
    <form class="dialog" (submit)="$event.preventDefault(); apply()">
      <h2>Batch Rotate Pages</h2>
      <div class="field">Pages
        <div class="radio-row">
          <label><input type="radio" name="which" [checked]="which() === 'all'" (change)="which.set('all')" /> All ({{ s.pageCount }})</label>
          <label><input type="radio" name="which" [checked]="which() === 'current'" (change)="which.set('current')" /> {{ s.pageName(s.currentPageIndex) }}</label>
          <label><input type="radio" name="which" [checked]="which() === 'range'" (change)="which.set('range')" /> Range</label>
        </div>
        @if (which() === 'range') {
          <input placeholder="1-3, 5, 8" [value]="range()" (input)="range.set($any($event.target).value)" />
          @if (pages().length === 0) { <p class="error-text">Type page numbers between 1 and {{ s.pageCount }}</p> }
        }
      </div>
      <label class="field">Rotation
        <select (change)="angle.set(+$any($event.target).value)">
          <option value="90" [selected]="angle() === 90">90° right (clockwise)</option>
          <option value="-90" [selected]="angle() === -90">90° left (counterclockwise)</option>
          <option value="180" [selected]="angle() === 180">180°</option>
        </select>
      </label>
      <p class="secondary small">Markups and measurements turn with the drawing.</p>
      <div class="dialog-buttons">
        <button type="button" (click)="store.closeBatchRotate()">Cancel</button>
        <button type="submit" class="primary" [disabled]="pages().length === 0">
          Rotate {{ pages().length }} page{{ pages().length === 1 ? '' : 's' }}
        </button>
      </div>
    </form>
  `,
})
export class RotatePagesDialog {
  readonly store = inject(DrawingStore);
  readonly which = signal<'all' | 'current' | 'range'>('all');
  readonly range = signal('');
  readonly angle = signal(90);

  readonly pages = computed(() => {
    const count = this.store.watch().pageCount;
    if (this.which() === 'all') return Array.from({ length: count }, (_, i) => i);
    if (this.which() === 'current') return [this.store.currentPageIndex];
    return parseRange(this.range(), count);
  });

  apply(): void {
    this.store.rotatePages(this.pages(), this.angle());
    this.store.closeBatchRotate();
  }
}

// "1-3, 5" → [0, 1, 2, 4] (pages that exist only)
function parseRange(text: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,;\s]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= count) out.add(n - 1);
  }
  return [...out].sort((x, y) => x - y);
}
