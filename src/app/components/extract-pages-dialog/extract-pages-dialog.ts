import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { parseRange } from '../insert-pages-dialog/insert-pages-dialog';

// Extract Pages (like Revu): copy the selected pages, a range or the current page into a new PDF,
// with their markups and measurements. Optionally one file per page, and/or delete them here.
@Component({
  selector: 'app-extract-pages-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.closeExtract()' },
  template: `
    @let s = store.watch();
    <form class="dialog" (submit)="$event.preventDefault(); apply()">
      <h2>Extract Pages</h2>
      <div class="field">Pages
        <div class="radio-row">
          <label><input type="radio" name="which" [checked]="which() === 'selected'" (change)="which.set('selected')" />
            Selected ({{ s.selectedPages.length }})</label>
          <label><input type="radio" name="which" [checked]="which() === 'range'" (change)="which.set('range')" /> Range</label>
          <label><input type="radio" name="which" [checked]="which() === 'all'" (change)="which.set('all')" /> All ({{ s.pageCount }})</label>
        </div>
        @if (which() === 'selected') {
          <p class="secondary small extract-names">{{ names() }}</p>
          <p class="secondary small">Ctrl + click or Shift + click pages in the tree or the Pages panel to select more.</p>
        }
        @if (which() === 'range') {
          <input placeholder="1-3, 5, 8" [value]="range()" (input)="range.set($any($event.target).value)" />
          @if (pages().length === 0) { <p class="error-text">Type page numbers between 1 and {{ s.pageCount }}</p> }
        }
      </div>
      <label class="check-row"><input type="checkbox" [checked]="separate()" (change)="separate.set($any($event.target).checked)" />
        One file per page (named after the page)</label>
      <label class="check-row"><input type="checkbox" [checked]="deleteAfter()" [disabled]="pages().length >= s.pageCount"
             (change)="deleteAfter.set($any($event.target).checked)" />
        Delete the pages from this document after extracting</label>
      <p class="secondary small">The new PDF keeps the markups, measurements, scales and page names.</p>
      <div class="dialog-buttons">
        <button type="button" (click)="store.closeExtract()">Cancel</button>
        <button type="submit" class="primary" [disabled]="pages().length === 0 || busy()">
          Extract {{ pages().length }} page{{ pages().length === 1 ? '' : 's' }}
        </button>
      </div>
    </form>
  `,
  styles: [`.extract-names { max-height: 72px; overflow: auto; margin: 4px 0 0; }`],
})
export class ExtractPagesDialog {
  readonly store = inject(DrawingStore);
  readonly which = signal<'selected' | 'range' | 'all'>('selected');
  readonly range = signal('');
  readonly separate = signal(false);
  readonly deleteAfter = signal(false);
  readonly busy = signal(false);

  readonly pages = computed(() => {
    const s = this.store.watch();
    if (this.which() === 'all') return Array.from({ length: s.pageCount }, (_, i) => i);
    if (this.which() === 'selected') return s.selectedPages;
    return parseRange(this.range(), s.pageCount);
  });

  readonly names = computed(() => this.pages().map(i => this.store.pageName(i)).join(', '));

  async apply(): Promise<void> {
    this.busy.set(true);
    try {
      const del = this.deleteAfter() && this.pages().length < this.store.pageCount;
      if (await this.store.extractPages(this.pages(), this.separate(), del)) this.store.closeExtract();
    } finally {
      this.busy.set(false);
    }
  }
}
