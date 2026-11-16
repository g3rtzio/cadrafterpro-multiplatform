import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { PageLabeler } from '../../services/page-labels/page-labels';
import { parseRange } from '../insert-pages-dialog/insert-pages-dialog';

// "Create Page Labels" (like Revu): name the pages from the bookmarks, or from the text
// inside a box drawn on a page (the sheet number of the title block), for all pages or a range
@Component({
  selector: 'app-page-labels-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'labeler.close()' },
  styles: [`
    .options { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
    .option { display: flex; align-items: center; gap: 8px; }
    .option .spacer { flex: 1; }
    .preview { font-size: 12px; color: var(--secondary); padding-left: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview b { color: var(--text); font-weight: 600; }
    .range { display: flex; align-items: center; gap: 8px; }
    .range select { flex: 1; }
    .range input { flex: 1; min-width: 0; }
    .busy { font-size: 12px; color: var(--accent); }
  `],
  template: `
    @let s = store.watch();
    <form class="dialog" (submit)="$event.preventDefault(); ok()">
      <h2>Create Page Labels</h2>

      <div class="options">
        <span class="caption-label">Options</span>
        <label class="option">
          <input type="radio" name="source" [checked]="labeler.source() === 'bookmarks'" (change)="labeler.source.set('bookmarks')" />
          Bookmarks
        </label>
        <div class="option">
          <label class="option">
            <input type="radio" name="source" [checked]="labeler.source() === 'region'" (change)="labeler.source.set('region')" />
            Page Region
          </label>
          <span class="spacer"></span>
          <button type="button" [disabled]="busy()" (click)="labeler.startSelecting()">Select</button>
        </div>
        @if (labeler.source() === 'region') {
          <div class="preview">
            @if (labeler.preview(); as text) { Text in the box: <b>{{ text }}</b> }
            @else { Click Select and drag a box around the sheet number }
          </div>
        }
      </div>

      <div class="options">
        <span class="caption-label">Page Range</span>
        <div class="range">Pages:
          <select (change)="labeler.allPages.set(value($event) === 'all')">
            <option value="all" [selected]="labeler.allPages()">All Pages (1 - {{ s.pageCount }})</option>
            <option value="range" [selected]="!labeler.allPages()">Range</option>
          </select>
          <span class="secondary">of {{ s.pageCount }}</span>
        </div>
        @if (!labeler.allPages()) {
          <input placeholder="1-3, 5, 8" [value]="labeler.range()" (input)="labeler.range.set(value($event))" />
          @if (pages().length === 0) { <p class="error-text">Type page numbers between 1 and {{ s.pageCount }}</p> }
        }
      </div>

      @if (labeler.progress(); as p) { <div class="busy">{{ p }}</div> }

      <div class="dialog-buttons">
        <button type="button" (click)="labeler.close()">Cancel</button>
        <button type="submit" class="primary" [disabled]="!canApply()">OK</button>
      </div>
    </form>
  `,
})
export class PageLabelsDialog {
  readonly store = inject(DrawingStore);
  readonly labeler = inject(PageLabeler);
  readonly busy = computed(() => this.labeler.progress() !== null);

  // Page indexes chosen (0-based)
  readonly pages = computed(() => {
    const count = this.store.watch().pageCount;
    const numbers = this.labeler.allPages()
      ? Array.from({ length: count }, (_, i) => i + 1)
      : parseRange(this.labeler.range(), count);
    return numbers.map(n => n - 1);
  });

  readonly canApply = computed(() => !this.busy() && this.pages().length > 0
    && (this.labeler.source() === 'bookmarks' || this.labeler.region() !== null));

  ok(): void {
    if (this.canApply()) void this.labeler.apply(this.pages());
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
}
