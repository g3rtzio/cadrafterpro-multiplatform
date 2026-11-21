import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore, InsertFile } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// "Insert Pages" (like Revu's Insert Pages): which pages of the picked PDFs to bring in and where.
// Several files (picked together or dragged from Explorer) go in one after the other, in the
// order of the list, which can be changed here.
@Component({
  selector: 'app-insert-pages-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.cancelInsertPages()' },
  styles: [`
    .files { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto;
             border: 1px solid var(--border); border-radius: 8px; }
    .file { display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; }
    .file + .file { border-top: 1px solid var(--border); }
    .file .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file .count { font-size: 11px; color: var(--secondary); white-space: nowrap; }
    .file .order { width: 18px; text-align: right; font-size: 11px; color: var(--secondary); }
  `],
  template: `
    @let s = store.watch();
    @if (s.insertRequest; as r) {
      <form class="dialog" (submit)="$event.preventDefault(); insert()">
        <h2>Insert Pages</h2>

        @if (files().length === 1) {
          <p class="secondary">{{ files()[0].name }} · {{ files()[0].pageCount }} page{{ files()[0].pageCount === 1 ? '' : 's' }}</p>
          <div class="field">Pages
            <div class="radio-row">
              <label><input type="radio" name="which" [checked]="all()" (change)="all.set(true)" /> All</label>
              <label><input type="radio" name="which" [checked]="!all()" (change)="all.set(false)" /> Range</label>
            </div>
            @if (!all()) {
              <input placeholder="1-3, 5, 8" [value]="range()" (input)="range.set(text($event))" />
              @if (total() === 0) { <p class="error-text">Type page numbers between 1 and {{ files()[0].pageCount }}</p> }
            }
          </div>
        } @else {
          <div class="field">Files (all their pages, in this order)
            <div class="files">
              @for (f of files(); track f; let i = $index, first = $first, last = $last) {
                <div class="file">
                  <span class="order">{{ i + 1 }}</span>
                  <span class="name" [title]="f.name">{{ f.name }}</span>
                  <span class="count">{{ f.pageCount }} p.</span>
                  <button type="button" class="icon-button" title="Move up" [disabled]="first" (click)="move(i, -1)">
                    <app-icon class="icon small" name="arrow_upward" /></button>
                  <button type="button" class="icon-button" title="Move down" [disabled]="last" (click)="move(i, 1)">
                    <app-icon class="icon small" name="arrow_downward" /></button>
                  <button type="button" class="icon-button" title="Leave this file out" (click)="remove(i)">
                    <app-icon class="icon small" name="close" /></button>
                </div>
              }
            </div>
          </div>
        }

        <label class="field">Position
          <select (change)="position.set(text($event))">
            @if (r.at !== s.currentPageIndex + 1) {
              <option value="drop" [selected]="position() === 'drop'">
                {{ r.at >= s.pageCount ? 'After the last page (where dropped)' : 'Before ' + s.pageName(r.at) + ' (where dropped)' }}
              </option>
            }
            <option value="after" [selected]="position() === 'after'">After {{ s.pageName(s.currentPageIndex) }}</option>
            <option value="before" [selected]="position() === 'before'">Before {{ s.pageName(s.currentPageIndex) }}</option>
            <option value="start" [selected]="position() === 'start'">At the beginning</option>
            <option value="end" [selected]="position() === 'end'">At the end</option>
          </select>
        </label>

        <div class="dialog-buttons">
          <button type="button" (click)="s.cancelInsertPages()">Cancel</button>
          <button type="submit" class="primary" [disabled]="total() === 0">
            Insert {{ total() }} page{{ total() === 1 ? '' : 's' }}
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
  // Files in the order their pages go in (the user can reorder or leave some out)
  readonly files = signal<InsertFile[]>(this.store.insertRequest?.files ?? []);

  // Page numbers chosen for each file (1-based). A range only applies to a single file.
  readonly pages = computed(() => this.files().map(f => {
    if (this.files().length > 1 || this.all()) return Array.from({ length: f.pageCount }, (_, i) => i + 1);
    return parseRange(this.range(), f.pageCount);
  }));
  readonly total = computed(() => this.pages().reduce((sum, list) => sum + list.length, 0));

  move(index: number, step: number): void {
    const list = [...this.files()];
    const [file] = list.splice(index, 1);
    list.splice(index + step, 0, file);
    this.files.set(list);
  }

  remove(index: number): void {
    const list = this.files().filter((_, i) => i !== index);
    if (list.length === 0) return this.store.cancelInsertPages();
    this.files.set(list);
  }

  insert(): void {
    const s = this.store;
    const r = s.insertRequest;
    if (!r || this.total() === 0) return;
    r.files = this.files();
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
