import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { COLORS } from '../../models/takeoff';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { SearchHit, TextSearch } from '../../services/text-search/text-search';
import { Icon } from '../icon/icon';

// Search panel of the right side bar (like Revu's Search): text box, where to search,
// options, and the results grouped by page. Click a result to zoom to it on the plan.
// Tick results to act on them (lightning menu): highlight, underline, squiggly, strikethrough,
// mark for redaction, hyperlink, or put a count of an element on each one.
@Component({
  selector: 'app-search-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties search-panel', '(document:click)': 'menuOpen.set(false)' },
  template: `
    @let s = store.watch();
    <section class="panel-section">
      <h3>Search</h3>
      <div class="search-row">
        <div class="search-box">
          <app-icon class="icon small secondary" name="search" />
          <input #field type="text" placeholder="Find text" [value]="search.query()" [disabled]="!s.hasDocument"
                 (input)="search.query.set(value($event))" (keydown.enter)="onEnter($event)"
                 (keydown.escape)="clear()" />
          @if (search.query()) {
            <button class="icon-button" title="Clear" (click)="clear()"><app-icon class="icon small" name="close" /></button>
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
        <app-icon class="icon small" [name]="showOptions() ? 'expand_more' : 'chevron_right'" /> Options
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
          <button class="icon-button" title="Previous Result (⇧Enter)" (click)="search.step(-1)"><app-icon class="icon small" name="keyboard_arrow_up" /></button>
          <button class="icon-button" title="Next Result (Enter)" (click)="search.step(1)"><app-icon class="icon small" name="keyboard_arrow_down" /></button>
        }
      </div>
      @if (search.busy()) {
        <div class="secondary small">{{ search.progress() }}</div>
      }
      @if (search.results().length) {
        @let ticked = search.checked().size;
        <!-- Tick all, actions on the ticked results, remove them from the list -->
        <div class="results-tools">
          <input type="checkbox" title="Select All" [checked]="ticked > 0 && ticked === search.results().length"
                 [indeterminate]="ticked > 0 && ticked < search.results().length" (change)="search.setAll(checked($event))" />
          <span class="secondary small">{{ ticked ? ticked + ' checked' : 'Select all' }}</span>
          <span class="spacer"></span>
          <div class="menu-anchor">
            <button class="icon-button" title="Actions on the checked results" [disabled]="!ticked"
                    (click)="$event.stopPropagation(); menuOpen.set(!menuOpen()); panel.set(null)">
              <app-icon class="icon small" name="bolt" /><app-icon class="icon small" name="expand_more" />
            </button>
            @if (menuOpen()) {
              <div class="menu actions-menu" (click)="$event.stopPropagation()">
                <button class="menu-item" (click)="openPanel('link')"><app-icon class="icon small" name="link" /> Hyperlink Checked…</button>
                <button class="menu-item" (click)="mark('Redact')"><app-icon class="icon small" name="ink_eraser" /> Mark for Redaction</button>
                <button class="menu-item" (click)="openPanel('count')"><app-icon class="icon small" name="tally_mark_4" /> Apply Count Measurement to Checked…</button>
                <div class="menu-divider"></div>
                <button class="menu-item" (click)="mark('Highlight')"><app-icon class="icon small" name="ink_highlighter" /> Highlight Checked</button>
                <button class="menu-item" (click)="mark('Underline')"><app-icon class="icon small" name="format_underlined" /> Underline Checked</button>
                <button class="menu-item" (click)="mark('Squiggly')"><app-icon class="icon small" name="format_underlined_squiggle" /> Squiggly Checked</button>
                <button class="menu-item" (click)="mark('StrikeOut')"><app-icon class="icon small" name="strikethrough_s" /> Strikethrough Checked</button>
              </div>
            }
          </div>
          <button class="icon-button" title="Remove the checked results from the list" [disabled]="!ticked" (click)="search.removeChecked()">
            <app-icon class="icon small" name="delete" />
          </button>
        </div>

        <!-- Apply Count Measurement to Checked: pick the element (or make a new one) -->
        @if (panel() === 'count') {
          <div class="action-box">
            <div class="action-title">Apply Count to {{ ticked }} result{{ ticked === 1 ? '' : 's' }}</div>
            <div class="search-box">
              <app-icon class="icon small secondary" name="search" />
              <input type="text" placeholder="Find element" [value]="countFilter()" (input)="countFilter.set(value($event))" />
            </div>
            <div class="picker-header">New count</div>
            <div class="new-count">
              <input type="text" [value]="newName()" (input)="newName.set(value($event))" placeholder="Name" />
              @for (c of newColors; track c) {
                <button class="color-dot" [style.background]="c" [title]="'New count in this color'" (click)="applyNewCount(c)"></button>
              }
            </div>
            <div class="picker-header">Count elements</div>
            @for (item of countItems(); track item.id) {
              <button class="picker-row" (click)="applyCount(item.id)">
                <span class="swatch" [style.background]="item.color"></span>{{ item.name }}
                <span class="spacer"></span><span class="secondary small">{{ countOf(item.id) }} ea</span>
              </button>
            } @empty {
              <div class="secondary small">No count elements{{ countFilter() ? ' match' : ' yet' }}.</div>
            }
            <div class="row-buttons"><button (click)="panel.set(null)">Cancel</button></div>
          </div>
        }

        <!-- Hyperlink Checked: a web address or a page of this drawing -->
        @if (panel() === 'link') {
          <div class="action-box">
            <div class="action-title">Hyperlink {{ ticked }} result{{ ticked === 1 ? '' : 's' }}</div>
            <div class="segmented">
              <button [class.active]="linkKind() === 'page'" (click)="linkKind.set('page')">Page</button>
              <button [class.active]="linkKind() === 'uri'" (click)="linkKind.set('uri')">Web Address</button>
            </div>
            @if (linkKind() === 'page') {
              <select (change)="linkPage.set(+value($event))">
                @for (i of pageIndexes(); track i) {
                  <option [value]="i" [selected]="linkPage() === i">{{ s.pageName(i) }}</option>
                }
              </select>
            } @else {
              <input type="text" placeholder="https://…" [value]="linkUri()" (input)="linkUri.set(value($event))" />
            }
            <div class="row-buttons">
              <button (click)="panel.set(null)">Cancel</button>
              <button class="primary" [disabled]="linkKind() === 'uri' && !linkUri().trim()" (click)="applyLink()">Add Links</button>
            </div>
          </div>
        }
      }

      @for (group of groups(); track group.pageIndex) {
        <div class="result-page">
          <input type="checkbox" [checked]="allChecked(group.hits)" (change)="search.toggleGroup(group.hits, checked($event))" />
          {{ s.pageName(group.pageIndex) }} <span class="secondary">({{ group.hits.length }})</span>
        </div>
        @for (hit of group.hits; track hit.id) {
          <div class="result-row" [class.current]="search.focused() === hit">
            <input type="checkbox" [checked]="search.isChecked(hit)" (change)="search.toggle(hit)" />
            <button class="result-text" (click)="search.focus(hit)">
              @if (hit.source === 'markup') { <app-icon class="icon small secondary" name="sticky_note_2" /> }
              <span class="snippet">{{ hit.before }}<mark>{{ hit.match }}</mark>{{ hit.after }}</span>
            </button>
          </div>
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
    .result-page { display: flex; align-items: center; gap: 4px; font-weight: 600; font-size: 12px; margin-top: 6px; }
    .result-row { display: flex; align-items: flex-start; gap: 2px; border-radius: 5px; padding-left: 4px; }
    .result-row input { margin-top: 4px; }
    .result-text {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: flex-start;
      gap: 4px;
      border: none;
      background: transparent;
      text-align: left;
      padding: 3px 4px;
      font-size: 12px;
    }
    .results-tools { display: flex; align-items: center; gap: 4px; padding: 2px 0 2px 4px; border-bottom: 1px solid var(--border); }
    .actions-menu { left: auto; right: 0; min-width: 250px; }
    .action-box { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; padding: 8px; border: 1px solid var(--border);
      border-radius: 7px; background: var(--panel); }
    .action-title { font-weight: 600; }
    .picker-header { font-size: 11px; font-weight: 600; color: var(--secondary); margin-top: 2px; }
    .picker-row { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: transparent;
      text-align: left; padding: 3px 4px; border-radius: 5px; }
    .picker-row:hover { background: var(--hover); }
    .new-count { display: flex; align-items: center; gap: 4px; }
    .new-count input { flex: 1; min-width: 0; }
    .color-dot { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.2); flex: none; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .result-row.current { background: var(--accent-soft); }
    .snippet { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    mark { background: rgba(255, 149, 0, 0.55); color: inherit; border-radius: 2px; padding: 0 1px; }
  `],
})
export class SearchPanel {
  readonly store = inject(DrawingStore);
  readonly search = inject(TextSearch);
  readonly showOptions = signal(true);
  readonly menuOpen = signal(false);
  readonly panel = signal<'count' | 'link' | null>(null);
  readonly countFilter = signal('');
  readonly newName = signal('');
  readonly linkKind = signal<'page' | 'uri'>('page');
  readonly linkPage = signal(0);
  readonly linkUri = signal('');
  readonly newColors = [COLORS.red, COLORS.orange, COLORS.green, COLORS.blue, COLORS.purple];
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

  // Count elements for the picker (filtered by the text typed above them)
  countItems() {
    const q = this.countFilter().trim().toLowerCase();
    return this.store.watch().items.filter(i => i.kind === 'count' && (!q || i.name.toLowerCase().includes(q)));
  }

  countOf(itemId: string): number {
    return this.store.measurements.filter(m => m.itemId === itemId).reduce((n, m) => n + m.points.length, 0);
  }

  pageIndexes(): number[] {
    return Array.from({ length: this.store.pageCount }, (_, i) => i);
  }

  allChecked(hits: SearchHit[]): boolean {
    return hits.every(h => this.search.isChecked(h));
  }

  openPanel(kind: 'count' | 'link'): void {
    this.menuOpen.set(false);
    this.panel.set(kind);
    if (kind === 'count') {
      this.countFilter.set('');
      this.newName.set(this.search.query().trim());
    } else {
      this.linkPage.set(this.store.currentPageIndex);
    }
  }

  mark(subtype: 'Highlight' | 'Underline' | 'Squiggly' | 'StrikeOut' | 'Redact'): void {
    this.menuOpen.set(false);
    this.search.markChecked(subtype);
  }

  applyCount(itemId: string): void {
    this.search.countChecked(itemId);
    this.panel.set(null);
  }

  // New count element (named after the search by default) with a count on every ticked result
  applyNewCount(color: string): void {
    const s = this.store;
    const name = this.newName().trim() || 'Count';
    s.addItem(name, 'count', color);
    const item = s.items[s.items.length - 1];
    s.cancelTool();                       // addItem starts measuring with it; here the counts are placed for you
    this.applyCount(item.id);
  }

  applyLink(): void {
    const uri = this.linkUri().trim();
    this.search.linkChecked(this.linkKind() === 'uri' ? { uri: /^[a-z]+:/i.test(uri) ? uri : 'https://' + uri } : { page: this.linkPage() });
    this.panel.set(null);
  }

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
