import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ColumnDef } from '../../models/estimate';
import { filterText, matchesColumnText } from '../../models/estimate-filter';
import { ESTIMATE_PART_DRAG_TYPE, PART_DRAG_TYPE } from '../../models/templates';
import { DrawingStore, EstimateRow } from '../../services/drawing.store/drawing.store';
import { CostDatabase, TemplateLibrary } from '../../services/template-library/template-library';
import { Icon } from '../icon/icon';

// One line of the table: a group, an element, or a part (indented under its parent)
interface Line {
  row: EstimateRow;
  depth: number;
  open: boolean;
  canOpen: boolean;
  draggable: boolean;              // top-level rows can be moved into and out of groups
}

// "Estimating" tab: every element in the document with its properties (PlanSwift style)
// — port of EstimateView.swift.
// The columns come from the Columns window. Parts hang under their element (sub-items).
// Click selects a row (Shift + click: every row up to it, Ctrl / ⌘ + click: one more),
// double-click opens its Properties, Delete removes the selected parts and groups.
// Nothing is grouped by default: "New Group" makes a folder and rows are dragged into it.
// Dragging a row onto the empty part of the table takes it out of its group.
// Parts can be dragged onto an element or another part (they become its sub-items), and so can
// part templates and Cost Database parts from the right side bar.
// The search box shows only the rows whose name matches (with the rows above them).
// The row under the headers filters each column ("concrete", "> 10", "<= 5", "= 0", "<> 2"), and the
// Filter builder (Estimating › Filter) adds conditions on any property; both keep the rows above.
@Component({
  selector: 'app-estimate-view',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'estimate',
    tabindex: '0',
    '(dragover)': 'allowDrop($event)',
    '(drop)': 'dropOn(null, $event)',
    '(keydown.delete)': 'deleteKey($event)',
    '(keydown.backspace)': 'deleteKey($event)',
    '(keydown.enter)': 'store.openProperties()',
    '(click)': 'store.selectEstimateRow(null)',
  },
  template: `
    @let s = store.watch();
    <div class="estimate-title">
      <span class="estimate-file">{{ s.fileName || 'Estimate' }}</span>
      <div class="side-search estimate-search">
        <app-icon class="icon small secondary" name="search" />
        <input type="text" placeholder="Find element or part" [value]="filter()" (input)="filter.set(value($event))"
               (click)="$event.stopPropagation()" (keydown.delete)="$event.stopPropagation()"
               (keydown.backspace)="$event.stopPropagation()" (keydown.enter)="$event.stopPropagation()"
               (keydown.escape)="filter.set('')" />
        @if (filter()) {
          <button class="icon-button" title="Clear" (click)="filter.set(''); $event.stopPropagation()">
            <app-icon class="icon small" name="close" />
          </button>
        }
      </div>
    </div>
    @if (s.filterActive) {
      <div class="filter-bar">
        <app-icon class="icon small accent" name="filter_alt" />
        <span class="filter-text" [title]="filterSummary()">
          Filter{{ s.estimateFilterName ? ' "' + s.estimateFilterName + '"' : '' }}: {{ filterSummary() }}
        </span>
        <button (click)="s.openFilter(); $event.stopPropagation()">Edit…</button>
        <button (click)="s.setEstimateFilter(null); $event.stopPropagation()">Clear</button>
      </div>
    }
    @if (lines().length === 0 && (filter() || filtering())) {
      <div class="estimate-empty">
        <app-icon class="icon big" name="search" />
        <div class="estimate-empty-title">No Matches</div>
        <div class="secondary">No element or part passes the search and the filters.</div>
        @if (hasColumnFilters()) { <button (click)="columnFilters.set({}); $event.stopPropagation()">Clear Column Filters</button> }
      </div>
    } @else if (lines().length === 0) {
      <div class="estimate-empty">
        <app-icon class="icon big" name="list_alt" />
        <div class="estimate-empty-title">No Elements</div>
        <div class="secondary">Measure on the plan or open a PDF with markups.</div>
      </div>
    } @else {
      <table class="estimate-table resizable">
        <thead>
          <tr>
            @for (col of columns(); track col.id) {
              <!-- Drag the right edge of a header to change the width of the column -->
              <th [class.num]="col.type === 'number' && col.name !== 'Name'" [style.width.px]="col.width ?? defaultWidth(col)">
                {{ col.name }}
                <span class="col-resize" title="Drag to change the width" (mousedown)="startResize(col, $event)"
                      (click)="$event.stopPropagation()"></span>
              </th>
              @if (col.showUnits) { <th class="units-col">Units</th> }
            }
          </tr>
          <!-- Filter of each column -->
          <tr class="filter-row">
            @for (col of columns(); track col.id) {
              <th>
                <input type="text" [placeholder]="col.type === 'number' && col.name !== 'Name' ? '> 0' : 'Filter'"
                       [value]="columnFilters()[col.id] ?? ''" [class.on]="!!columnFilters()[col.id]"
                       [title]="'Filter ' + col.name + ': text it contains, or > 10, >= 5, < 3, = 0, <> 2'"
                       (input)="setColumnFilter(col.id, value($event))" (click)="$event.stopPropagation()"
                       (keydown.delete)="$event.stopPropagation()" (keydown.backspace)="$event.stopPropagation()"
                       (keydown.enter)="$event.stopPropagation()" (keydown.escape)="setColumnFilter(col.id, '')" />
              </th>
              @if (col.showUnits) { <th class="units-col"></th> }
            }
          </tr>
        </thead>
        <tbody>
          @for (line of lines(); track line.row.id) {
            @let row = line.row;
            <tr [class.folder-row]="row.isFolder" [class.part-row]="row.kind === 'part'"
                [class.selected]="s.isEstimateSelected(row.key)"
                [class.draggable]="line.draggable || row.kind === 'part'"
                [attr.draggable]="line.draggable || row.kind === 'part' ? 'true' : null"
                [class.drop-target]="dropTarget() === row.id"
                (click)="select(row, $event)" (dblclick)="open(row)"
                (dragstart)="dragStart(row, $event)"
                (dragover)="rowDragOver(row, $event)" (dragleave)="dropTarget.set(null)"
                (drop)="rowDrop(row, $event)">
              @for (col of columns(); track col.id) {
                @if (col.name === 'Name') {
                  <td class="name-cell" [style.padding-left.px]="12 + line.depth * 20">
                    <span class="chevron" (click)="toggle(row, $event)">
                      @if (line.canOpen) { <app-icon class="icon small" [name]="line.open ? 'expand_more' : 'chevron_right'" /> }
                    </span>
                    @if (row.isFolder) {
                      <app-icon class="icon small secondary" name="folder" />
                      @if (editing() === row.id) {
                        <input class="rename" [value]="row.name" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()"
                               (keydown.enter)="rename(row, $event)" (keydown.escape)="editing.set(null)"
                               (keydown.delete)="$event.stopPropagation()" (keydown.backspace)="$event.stopPropagation()"
                               (blur)="rename(row, $event)" />
                      } @else {
                        <b title="Double-click to rename">{{ row.name }}</b>
                        <span class="secondary small"> ({{ row.children.length }})</span>
                        <button class="icon-button inline" title="Delete Group (its rows stay)"
                                (click)="s.deleteEstimateGroup(row.id); $event.stopPropagation()">
                          <app-icon class="icon small" name="delete" />
                        </button>
                      }
                    } @else if (row.kind === 'part') {
                      <app-icon class="icon small part-icon" title="Part" name="deployed_code" /><span [class.match]="matches(row)">{{ row.name }}</span>
                    } @else {
                      <span class="swatch" [style.background]="row.color"></span><span [class.match]="matches(row)">{{ row.name }}</span>
                    }
                  </td>
                } @else {
                  @let cell = s.cellValue(row, col);
                  <td [class.num]="col.type === 'number'" [class.qty]="col.name === 'Qty'"
                      [class.secondary]="col.name === 'Pages'">
                    @if (col.name === 'Color' && !row.isFolder) {
                      <span class="swatch" [style.background]="row.color"></span>
                    }
                    {{ cell.text }}
                  </td>
                }
                @if (col.showUnits) { <td>{{ units(row, col) }}</td> }
              }
            </tr>
            @if (row.isFolder && line.open && row.children.length === 0) {
              <tr><td class="secondary small" [style.padding-left.px]="52" [attr.colspan]="span()">Drag elements here</td></tr>
            }
          }
        </tbody>
      </table>
    }
  `,
})
export class EstimateView {
  readonly store = inject(DrawingStore);
  private readonly templates = inject(TemplateLibrary);
  private readonly costDatabase = inject(CostDatabase);
  readonly filter = signal('');                        // search box: names that contain this
  readonly editing = signal<string | null>(null);      // group being renamed
  readonly dropTarget = signal<string | null>(null);   // group under the dragged row

  // Reading the store here refreshes the table when something changes on the plan
  readonly columns = computed(() => this.store.watch().visibleColumns);
  readonly span = computed(() => this.columns().reduce((n, c) => n + (c.showUnits ? 2 : 1), 0));

  // Groups, their rows and every sub-item as one flat list (closed rows hide what is below)
  // Text of the filter row, by column id
  readonly columnFilters = signal<Record<string, string>>({});
  readonly hasColumnFilters = computed(() => Object.values(this.columnFilters()).some(v => v.trim()));
  readonly filtering = computed(() => this.store.watch().filterActive || this.hasColumnFilters());
  readonly filterSummary = computed(() => {
    const f = this.store.watch().estimateFilter;
    return f ? filterText(f) : '';
  });

  setColumnFilter(id: string, text: string): void {
    this.columnFilters.update(all => ({ ...all, [id]: text }));
  }

  // While searching or filtering: only the rows that pass, with the rows above them, all open.
  // A row whose name matches the search shows the parts below it (if they pass the filters).
  readonly lines = computed(() => {
    const s = this.store.watch();
    const q = this.filter().trim().toLowerCase();
    const filters = this.columnFilters();
    const columns = this.columns().filter(c => (filters[c.id] ?? '').trim());
    const filtering = this.filtering();
    const passes = (row: EstimateRow) => s.rowPassesFilter(row) && columns.every(c =>
      matchesColumnText(c.name === 'Name' ? row.name : s.cellValue(row, c).value ?? '', filters[c.id]));
    const cache = new Map<string, boolean>();
    const visible = (row: EstimateRow, inherited: boolean): boolean => {
      const key = row.id + (inherited ? '+' : '');
      const known = cache.get(key);
      if (known !== undefined) return known;
      const nameMatch = !!q && row.name.toLowerCase().includes(q);
      const searchOk = !q || inherited || nameMatch;
      const below = row.isFolder ? row.children : row.subRows;
      const kids = below.some(c => visible(c, inherited || nameMatch));
      const result = row.isFolder ? kids || (!filtering && searchOk) : (searchOk && (!filtering || passes(row))) || kids;
      cache.set(key, result);
      return result;
    };
    const out: Line[] = [];
    const add = (row: EstimateRow, depth: number, draggable: boolean, inherited: boolean) => {
      if (!visible(row, inherited)) return;
      const below = row.isFolder ? row.children : row.subRows;
      const open = !!q || filtering || !s.estimateCollapsed.has(row.id);
      out.push({ row, depth, open, canOpen: row.isFolder || below.length > 0, draggable });
      if (!open) return;
      const nameMatch = !!q && row.name.toLowerCase().includes(q);
      for (const child of below) add(child, depth + 1, row.isFolder, inherited || nameMatch);
    };
    for (const row of s.estimateFolders()) add(row, 0, !row.isFolder, false);
    return out;
  });

  matches(row: EstimateRow): boolean {
    const q = this.filter().trim().toLowerCase();
    return !!q && row.name.toLowerCase().includes(q);
  }

  value(event: Event): string { return (event.target as HTMLInputElement).value; }

  // Width of a column that was never resized: Name is wider, numbers narrower
  defaultWidth(col: ColumnDef): number {
    if (col.name === 'Name') return 260;
    if (col.name === 'Description') return 200;
    return col.type === 'number' ? 110 : 120;
  }

  // Drag the edge of a header: the width follows the mouse, released = saved
  startResize(col: ColumnDef, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = (event.target as HTMLElement).parentElement?.getBoundingClientRect().width ?? this.defaultWidth(col);
    const move = (e: MouseEvent) => this.store.setColumnWidth(col.id, startWidth + e.clientX - startX, false);
    const up = (e: MouseEvent) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-column');
      this.store.setColumnWidth(col.id, startWidth + e.clientX - startX, true);
    };
    document.body.classList.add('resizing-column');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // Units of a "Units" column: from the property (groups add up only rows with the same units)
  units(row: EstimateRow, col: ColumnDef): string {
    return this.store.cellValue(row, col).units;
  }

  private anchor: string | null = null;              // first row of a Shift + click range

  select(row: EstimateRow, event: MouseEvent): void {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).closest<HTMLElement>('app-estimate-view')?.focus();
    const s = this.store;
    const keys = this.lines().map(l => l.row.key);
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.anchor && keys.includes(this.anchor)) {
      const [i, j] = [keys.indexOf(this.anchor), keys.indexOf(row.key)].sort((a, b) => a - b);
      const range = keys.slice(i, j + 1);
      s.selectEstimateRows(toggle ? [...new Set([...s.estimateSelection, ...range])] : range, row.key);
      return;
    }
    this.anchor = row.key;
    if (toggle) {
      const current = s.estimateSelection;
      if (current.includes(row.key)) s.selectEstimateRows(current.filter(k => k !== row.key), null);
      else s.selectEstimateRows([...current, row.key], row.key);
      return;
    }
    s.selectEstimateRow(row.key);
  }

  // Double-click: Properties of an element or part; a group is renamed
  open(row: EstimateRow): void {
    if (row.isFolder) this.editing.set(row.id); else this.store.openProperties(row.key);
  }

  // Rows and groups start open; Collapse All / Expand All change this set
  toggle(row: EstimateRow, event: MouseEvent): void {
    event.stopPropagation();
    const set = this.store.estimateCollapsed;
    if (set.has(row.id)) set.delete(row.id); else set.add(row.id);
    this.store.touch();
  }

  rename(folder: EstimateRow, event: Event): void {
    if (this.editing() !== folder.id) return;
    this.editing.set(null);
    this.store.renameEstimateGroup(folder.id, (event.target as HTMLInputElement).value);
  }

  deleteKey(event: Event): void {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    this.store.deleteEstimateSelection();
  }

  // MARK: - Drag and drop (rows travel by name)
  dragStart(row: EstimateRow, event: DragEvent): void {
    // A selected row takes every selected top-level row with it (one name per line)
    const s = this.store;
    const names = s.isEstimateSelected(row.key)
      ? this.lines().filter(l => l.draggable && s.isEstimateSelected(l.row.key)).map(l => l.row.name) : [];
    event.dataTransfer?.setData('text/plain', names.length > 1 ? names.join('\n') : row.name);
    if (row.kind === 'part') event.dataTransfer?.setData(ESTIMATE_PART_DRAG_TYPE, row.key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
  }

  // A part (from the estimate or the side bar) over an element or part: it can go there
  private carriesPart(event: DragEvent): boolean {
    const types = event.dataTransfer?.types ?? [];
    return types.includes(PART_DRAG_TYPE) || types.includes(ESTIMATE_PART_DRAG_TYPE);
  }

  rowDragOver(row: EstimateRow, event: DragEvent): void {
    if (row.isFolder) {
      if (this.carriesPart(event) && !event.dataTransfer?.types.includes('text/plain')) return;
      this.allowDrop(event, row.id);
    } else if (this.carriesPart(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = event.dataTransfer.types.includes(PART_DRAG_TYPE) ? 'copy' : 'move';
      this.dropTarget.set(row.id);
    }
  }

  rowDrop(row: EstimateRow, event: DragEvent): void {
    if (row.isFolder) {
      this.dropOn(row.id, event);
      return;
    }
    const template = event.dataTransfer?.getData(PART_DRAG_TYPE);
    const moved = event.dataTransfer?.getData(ESTIMATE_PART_DRAG_TYPE);
    if (!template && !moved) return;
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget.set(null);
    if (template) {
      const { database, id } = JSON.parse(template) as { database: boolean; id: string };
      const lib = database ? this.costDatabase : this.templates;
      const t = lib.template(id);
      if (t) lib.addPartToDocument(t, row.key);
    } else if (moved) {
      this.store.movePart(moved, row.key);
    }
  }

  allowDrop(event: DragEvent, groupId: string | null = null): void {
    event.preventDefault();
    if (groupId) event.stopPropagation();
    this.dropTarget.set(groupId);
  }

  // groupId = null: dropped outside every group
  dropOn(groupId: string | null, event: DragEvent): void {
    if (groupId === null && event.dataTransfer?.types.includes(PART_DRAG_TYPE)) {
      this.dropTarget.set(null);
      return;                                // a side bar part needs an element to go under
    }
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget.set(null);
    const text = event.dataTransfer?.getData('text/plain');
    if (text) this.store.moveManyToEstimateGroup(text.split('\n').filter(Boolean), groupId);
  }
}
