import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store';
import { SearchHit, TextSearch } from '../../services/text-search';

// Search panel of the right side bar (like Revu's Search): text box, where to search,
// options, and the results grouped by page. Click a result to zoom to it on the plan.
@Component({
  selector: 'app-search-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties search-panel' },
  template: `
    @let s = store.watch();
    <section class="panel-section">
      <h3>Search</h3>
      <div class="search-row">
        <div class="search-box">
          <span class="icon small secondary">search</span>
          <input #field type="text" placeholder="Find text" [value]="search.query()" [disabled]="!s.hasDocument"
                 (input)="search.query.set(value($event))" (keydown.enter)="onEnter($event)"
                 (keydown.escape)="clear()" />
          @if (search.query()) {
            <button class="icon-button" title="Clear" (click)="clear()"><span class="icon small">close</span></button>
          }
        </div>
        <button class="primary" [disabled]="!s.hasDocument || !search.query().trim()" (click)="search.search()">Search</button>
      </div>
      <label class="field">Look in
        <select (change)="search.scope.set($any(value($event)))">
          <option value="document" [selected]="search.scope() === 'document'">Current Document</option>
          <option value="page" [selected]="search.scope() === 'page'">Current Page</option>
        </select>
      </label>
    </section>

    <!-- Options -->
    <section class="panel-section">
      <button class="section-toggle" (click)="showOptions.set(!showOptions())">
        <span class="icon small">{{ showOptions() ? 'expand_more' : 'chevron_right' }}</span> Options
      </button>
      @if (showOptions()) {
        <label class="check-field"><input type="checkbox" [checked]="search.searchText()"
               (change)="search.searchText.set(checked($event))" /> Search Pages</label>
        <label class="check-field"><input type="checkbox" [checked]="search.searchMarkups()"
               (change)="search.searchMarkups.set(checked($event))" /> Search Markups</label>
        <label class="check-field"><input type="checkbox" [checked]="search.caseSensitive()"
               (change)="search.caseSensitive.set(checked($event))" /> Case Sensitive</label>
        <label class="check-field"><input type="checkbox" [checked]="search.wholeWords()"
               (change)="search.wholeWords.set(checked($event))" /> Whole Words Only</label>
      }
    </section>

    <!-- Results -->
    <section class="panel-section results-section">
      <div class="results-header">
        <h3>Results</h3>
        <span class="spacer"></span>
        @if (search.results().length) {
          <span class="secondary small">{{ position() }}</span>
          <button class="icon-button" title="Previous Result (⇧Enter)" (click)="search.step(-1)"><span class="icon small">keyboard_arrow_up</span></button>
          <button class="icon-button" title="Next Result (Enter)" (click)="search.step(1)"><span class="icon small">keyboard_arrow_down</span></button>
        }
      </div>
      @if (search.busy()) {
        <div class="secondary small">{{ search.progress() }}</div>
      }
      @for (group of groups(); track group.pageIndex) {
        <div class="result-page">{{ s.pageName(group.pageIndex) }} <span class="secondary">({{ group.hits.length }})</span></div>
        @for (hit of group.hits; track hit.id) {
          <button class="result-row" [class.current]="search.focused() === hit" (click)="search.focus(hit)">
            @if (hit.source === 'markup') { <span class="icon small secondary">sticky_note_2</span> }
            <span class="snippet">{{ hit.before }}<mark>{{ hit.match }}</mark>{{ hit.after }}</span>
          </button>
        }
      } @empty {
        @if (search.searched() && !search.busy()) {
          <div class="secondary">No results</div>
        } @else if (!search.busy()) {
          <div class="secondary small">Type a word and press Enter. Drawings that are scanned images have no text to search.</div>
        }
      }
      @if (search.truncated()) {
        <div class="secondary small">Only the first {{ search.results().length }} results are shown.</div>
      }
    </section>
  `,
  styles: [`
    .search-row { display: flex; gap: 6px; align-items: center; }
    .search-box {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      padding: 0 2px 0 6px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .search-box input { flex: 1; min-width: 0; border: none; background: transparent; padding: 4px 0; outline: none; }
    .section-toggle {
      display: flex;
      align-items: center;
      gap: 2px;
      border: none;
      background: transparent;
      padding: 0;
      font-weight: 600;
    }
    .results-header { display: flex; align-items: center; gap: 2px; }
    .results-header h3 { margin: 0; }
    .result-page { font-weight: 600; font-size: 12px; margin-top: 6px; }
    .result-row {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      width: 100%;
      border: none;
      background: transparent;
      text-align: left;
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 12px;
    }
    .result-row.current { background: var(--accent-soft); }
    .snippet { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    mark { background: rgba(255, 149, 0, 0.55); color: inherit; border-radius: 2px; padding: 0 1px; }
  `],
})
export class SearchPanel {
  readonly store = inject(DrawingStore);
  readonly search = inject(TextSearch);
  readonly showOptions = signal(true);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private lastQuery = '';

  // Results grouped by page
  readonly groups = computed(() => {
    const groups: { pageIndex: number; hits: SearchHit[] }[] = [];
    for (const hit of this.search.results()) {
      const last = groups[groups.length - 1];
      if (last && last.pageIndex === hit.pageIndex) last.hits.push(hit);
      else groups.push({ pageIndex: hit.pageIndex, hits: [hit] });
    }
    return groups;
  });

  readonly position = computed(() => {
    const list = this.search.results();
    const i = list.indexOf(this.search.focused() as SearchHit);
    return `${i >= 0 ? i + 1 : 0} of ${list.length}`;
  });

  focusField(): void {
    const input = this.field()?.nativeElement;
    input?.focus();
    input?.select();
  }

  // Enter searches; pressed again with the same text it goes to the next result (⇧ = previous)
  onEnter(e: Event): void {
    const event = e as KeyboardEvent;
    const query = this.search.query().trim();
    if (query && query === this.lastQuery && this.search.results().length && !this.search.busy()) {
      this.search.step(event.shiftKey ? -1 : 1);
      return;
    }
    this.lastQuery = query;
    this.search.search();
  }

  clear(): void {
    this.search.query.set('');
    this.lastQuery = '';
    this.search.clear();
  }

  value(e: Event): string { return (e.target as HTMLInputElement).value; }
  checked(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
}
