import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';

// "Insert Pages" (like Revu's Insert Pages): which pages of the picked PDF to bring in and where
@Component({
  selector: 'app-insert-pages-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.cancelInsertPages()' },
  template: `
    @let s = store.watch();
    @if (s.insertRequest; as r) {
      <form class="dialog" (submit)="$event.preventDefault(); insert()">
        <h2>Insert Pages</h2>
        <p class="secondary">{{ r.name }} · {{ r.pageCount }} page{{ r.pageCount === 1 ? '' : 's' }}</p>

        <div class="field">Pages
          <div class="radio-row">
            <label><input type="radio" name="which" [checked]="all()" (change)="all.set(true)" /> All</label>
            <label><input type="radio" name="which" [checked]="!all()" (change)="all.set(false)" /> Range</label>
          </div>
          @if (!all()) {
            <input placeholder="1-3, 5, 8" [value]="range()" (input)="range.set(text($event))" />
            @if (pages().length === 0) { <p class="error-text">Type page numbers between 1 and {{ r.pageCount }}</p> }
          }
        </div>

        <label class="field">Position
          <select (change)="position.set(text($event))">
            <option value="after" [selected]="position() === 'after'">After {{ s.pageName(s.currentPageIndex) }}</option>
            <option value="before" [selected]="position() === 'before'">Before {{ s.pageName(s.currentPageIndex) }}</option>
            <option value="start" [selected]="position() === 'start'">At the beginning</option>
            <option value="end" [selected]="position() === 'end'">At the end</option>
            @if (r.at !== s.currentPageIndex + 1) {
              <option value="drop" [selected]="position() === 'drop'">Where it was dropped</option>
            }
          </select>
        </label>

        <div class="dialog-buttons">
          <button type="button" (click)="s.cancelInsertPages()">Cancel</button>
          <button type="submit" class="primary" [disabled]="pages().length === 0">
            Insert {{ pages().length }} page{{ pages().length === 1 ? '' : 's' }}
          </button>
        </div>
      </form>
    }
  `,
})
export class InsertPagesDialog {
  readonly store = inject(DrawingStore);
  readonly all = signal(true);
  readonly range = signal('');
  readonly position = signal(this.store.insertRequest && this.store.insertRequest.at !== this.store.currentPageIndex + 1
    ? 'drop' : 'after');

  // Page numbers chosen (1-based, in the order typed, no repeats)
  readonly pages = computed(() => {
    const count = this.store.watch().insertRequest?.pageCount ?? 0;
    if (this.all()) return Array.from({ length: count }, (_, i) => i + 1);
    return parseRange(this.range(), count);
  });

  insert(): void {
    const s = this.store;
    const r = s.insertRequest;
    if (!r || this.pages().length === 0) return;
    const current = s.currentPageIndex;
    const at = { after: current + 1, before: current, start: 0, end: s.pageCount, drop: r.at }[this.position()] ?? current + 1;
    void s.insertPages(this.pages(), at);
  }

  text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
}

// "1-3, 5, 8" → [1, 2, 3, 5, 8]
export function parseRange(text: string, count: number): number[] {
  const out: number[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) continue;
    const a = Number(match[1]), b = match[2] ? Number(match[2]) : a;
    const step = a <= b ? 1 : -1;
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) {
      if (n >= 1 && n <= count && !out.includes(n)) out.push(n);
    }
  }
  return out;
}
