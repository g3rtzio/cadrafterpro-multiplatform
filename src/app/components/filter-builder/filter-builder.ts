import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  FILTER_LOGICS, FILTER_OPS, FILTER_SPECIAL_FIELDS, FilterCondition, FilterGroup, FilterNode, NamedFilter, emptyFilter,
  filterText, matchesFilter, newCondition, newFilterId, parseFilter, presetFilters,
} from '../../models/estimate-filter';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// Filter builder of the estimate (like PlanSwift's).
// Left: the filters saved with a name (and a few ready-made ones); click one to edit it.
// Right: the filter being made, a tree of conditions joined by AND / OR (NOT AND / NOT OR negate
// the group). "Add Condition" and "Add Group" build it; each condition is a field (a property of
// the document, or IsTakeoffItem, IsPart, Name, Type, Pages, Color), how it compares and a value
// (the values found in the document are suggested). The tick of a condition turns it off without
// deleting it. The number of rows that pass is shown while editing.
// Save keeps it in the list (Estimating › Filter offers it later); Open… / Export… use .flt files.
// Apply shows the result and keeps the window open; OK applies and closes; Cancel goes back.
@Component({
  selector: 'app-filter-builder',
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'cancel()' },
  styles: [`
    .dialog.filter-dialog { width: 980px; }
    .layout { display: grid; grid-template-columns: 220px 1fr; gap: 12px; min-height: 360px; }
    .list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 6px; background: var(--panel);
      overflow: auto; max-height: 56vh; padding: 4px; }
    .list-title { font-size: 11px; font-weight: 600; color: var(--secondary); text-transform: uppercase; padding: 6px 6px 2px; }
    .list-item { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: transparent; text-align: left;
      padding: 4px 6px; border-radius: 5px; font-size: 13px; }
    .list-item:hover { background: var(--hover); }
    .list-item.on { background: var(--accent); color: #fff; }
    .list-item .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list-empty { font-size: 12px; color: var(--secondary); padding: 4px 6px; }
    .editor { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .name-row { display: flex; align-items: center; gap: 6px; }
    .name-row input { flex: 1; }
    .filter-tree { flex: 1; min-height: 240px; max-height: 46vh; overflow: auto; padding: 8px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--panel); font-size: 13px; }
    .node { display: flex; align-items: center; gap: 6px; padding: 3px 0; flex-wrap: wrap; }
    .node.off > :not(.tick):not(.remove) { opacity: 0.45; }
    .children { margin-left: 18px; padding-left: 10px; border-left: 1px dotted var(--border); }
    .logic { color: #d93025; font-weight: 600; }
    .root-label { font-weight: 600; }
    select, input { font-size: 12px; }
    .field { color: #1f9d55; width: 170px; }
    .op { color: #a0337a; }
    .value { width: 150px; }
    .add { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; padding: 2px 8px; }
    .summary { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--secondary); }
    .summary .count { font-weight: 600; color: var(--accent); white-space: nowrap; }
    .summary .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .add-hint { font-size: 12px; color: var(--secondary); padding: 4px 0; }
    .dialog-buttons .left { margin-right: auto; display: flex; gap: 6px; }
  `],
  template: `
    @let s = store.watch();
    <div class="dialog filter-dialog" (click)="$event.stopPropagation()">
      <h2><app-icon class="icon" name="filter_alt" /> Filter Builder</h2>
      <div class="layout">
        <!-- Saved and ready-made filters -->
        <div class="list">
          <button class="list-item" [class.on]="!selectedId()" (click)="startNew()">
            <app-icon class="icon small" name="add" /><span class="grow">New Filter</span>
          </button>
          <div class="list-title">Saved Filters</div>
          @for (f of s.savedFilters; track f.id) {
            <button class="list-item" [class.on]="selectedId() === f.id" [title]="summaryOf(f)" (click)="pick(f)">
              <app-icon class="icon small" name="filter_alt" /><span class="grow">{{ f.name }}</span>
            </button>
          } @empty {
            <div class="list-empty">None yet. Make a filter and press Save.</div>
          }
          <div class="list-title">Ready-made</div>
          @for (f of presets; track f.id) {
            <button class="list-item" [class.on]="selectedId() === f.id" [title]="summaryOf(f)" (click)="pick(f)">
              <app-icon class="icon small" name="bolt" /><span class="grow">{{ f.name }}</span>
            </button>
          }
        </div>

        <!-- The filter being made -->
        <div class="editor">
          <div class="name-row">
            <label for="filter-name">Name</label>
            <input id="filter-name" [value]="name()" placeholder="Name of the filter (to save it)" (input)="name.set(value($event))" />
            <button title="Save this filter in the list" [disabled]="isPreset()" (click)="save()">
              <app-icon class="icon small" name="save" /> Save
            </button>
            <button title="Save it as a new filter" (click)="saveAsNew()">Save as New</button>
            <button title="Delete this saved filter" [disabled]="!canDelete()" (click)="deleteSaved()">
              <app-icon class="icon small" name="delete" />
            </button>
          </div>
          <div class="filter-tree">
            <ng-container *ngTemplateOutlet="groupTpl; context: { $implicit: draft(), root: true }" />
          </div>
          <div class="summary">
            <span class="count">{{ matchCount() }} of {{ rowCount() }} rows</span>
            <span class="text" [title]="summary()">{{ summary() }}</span>
          </div>
        </div>
      </div>
      <datalist id="filter-fields">
        @for (f of fields(); track f) { <option [value]="f"></option> }
      </datalist>
      <div class="dialog-buttons">
        <span class="left">
          <button type="button" title="Open a filter from a .flt file" (click)="open()">Open…</button>
          <button type="button" title="Save this filter as a .flt file" (click)="exportFile()">Export…</button>
          <button type="button" title="Remove every condition" (click)="clearAll()">Clear</button>
        </span>
        <button type="button" (click)="ok()" class="primary">OK</button>
        <button type="button" (click)="cancel()">Cancel</button>
        <button type="button" (click)="apply()">Apply</button>
      </div>
    </div>

    <!-- A group: its logic, its buttons, then its conditions and groups -->
    <ng-template #groupTpl let-g let-root="root">
      <div class="node">
        @if (root) { <span class="root-label">Show rows where</span> }
        <select class="logic" [title]="logicHelp" (change)="g.logic = $any(value($event)); changed()">
          @for (l of logics; track l) { <option [value]="l" [selected]="g.logic === l">{{ logicLabel(l) }}</option> }
        </select>
        <button class="add" title="Add a condition to this group" (click)="addCondition(g)">
          <app-icon class="icon small" name="add" /> Condition
        </button>
        <button class="add" title="Add a group: its conditions are joined with their own AND / OR" (click)="addGroup(g)">
          <app-icon class="icon small" name="account_tree" /> Group
        </button>
        @if (!root) {
          <button class="icon-button remove" title="Remove this group" (click)="remove(g.id)"><app-icon class="icon small" name="close" /></button>
        }
      </div>
      <div class="children">
        @for (item of g.items; track item.id) {
          @if (item.kind === 'group') {
            <ng-container *ngTemplateOutlet="groupTpl; context: { $implicit: item, root: false }" />
          } @else {
            <div class="node" [class.off]="item.off">
              <input class="tick" type="checkbox" title="Use this condition" [checked]="!item.off"
                     (change)="item.off = !checked($event); changed()" />
              <input class="field" list="filter-fields" [value]="item.field" placeholder="Property"
                     (change)="setField(item, value($event))" />
              <select class="op" (change)="item.op = $any(value($event)); changed()">
                @for (o of ops; track o) { <option [value]="o" [selected]="item.op === o">{{ o }}</option> }
              </select>
              @if (item.op !== 'is blank' && item.op !== 'is not blank') {
                @if (isBoolean(item)) {
                  <select (change)="item.value = value($event); changed()">
                    <option value="True" [selected]="item.value === 'True'">True</option>
                    <option value="False" [selected]="item.value === 'False'">False</option>
                  </select>
                } @else {
                  <input class="value" [attr.list]="'filter-values-' + item.id" [value]="item.value" placeholder="Value"
                         (input)="item.value = value($event); changed()" />
                  <datalist [id]="'filter-values-' + item.id">
                    @for (v of valuesOf(item.field); track v) { <option [value]="v"></option> }
                  </datalist>
                }
              }
              <button class="icon-button remove" title="Remove this condition" (click)="remove(item.id)">
                <app-icon class="icon small" name="close" />
              </button>
            </div>
          }
        } @empty {
          <div class="add-hint">No conditions yet: press "Condition" to add one.</div>
        }
      </div>
    </ng-template>
  `,
})
export class FilterBuilder {
  readonly store = inject(DrawingStore);
  readonly ops = FILTER_OPS;
  readonly logics = FILTER_LOGICS;
  readonly presets = presetFilters();
  readonly logicHelp = 'All: every condition must pass (AND). Any: one is enough (OR). None / Not all: the opposite.';

  // Copy being edited (the estimate changes only on Apply / OK)
  readonly draft = signal<FilterGroup>(structuredClone(this.store.estimateFilter) ?? emptyFilter());
  readonly name = signal(this.store.estimateFilterName);
  readonly selectedId = signal<string | null>(
    this.store.savedFilters.find(f => f.name === this.store.estimateFilterName)?.id ?? null);
  private readonly rev = signal(0);
  // What the estimate showed before: Cancel goes back to it
  private readonly original = this.store.estimateFilter ? structuredClone(this.store.estimateFilter) : null;
  private readonly originalName = this.store.estimateFilterName;

  readonly fields = computed(() => {
    const names = this.store.watch().knownPropertyNames.filter(n => !FILTER_SPECIAL_FIELDS.includes(n));
    return [...FILTER_SPECIAL_FIELDS, ...names];
  });

  private readonly rows = computed(() => this.store.watch().allEstimateRows());
  readonly rowCount = computed(() => this.rows().length);
  readonly matchCount = computed(() => {
    this.rev();
    const f = this.draft();
    return this.rows().filter(r => matchesFilter(f, field => this.store.filterValue(r, field))).length;
  });

  readonly summary = computed(() => {
    this.rev();
    const text = filterText(this.draft());
    return text ? `Shows: ${text}` : 'No conditions: every row is shown';
  });

  readonly isPreset = computed(() => this.selectedId()?.startsWith('preset-') ?? false);
  readonly canDelete = computed(() => {
    this.store.watch();
    const id = this.selectedId();
    return !!id && this.store.savedFilters.some(f => f.id === id);
  });

  changed(): void { this.rev.update(v => v + 1); }

  logicLabel(l: string): string {
    return { 'AND': 'All (AND)', 'OR': 'Any (OR)', 'NOT AND': 'Not all (NOT AND)', 'NOT OR': 'None (NOT OR)' }[l] ?? l;
  }

  isBoolean(c: FilterCondition): boolean { return c.field === 'IsTakeoffItem' || c.field === 'IsPart'; }

  setField(c: FilterCondition, field: string): void {
    c.field = field;
    if (this.isBoolean(c) && c.value !== 'True' && c.value !== 'False') c.value = 'True';
    this.changed();
  }

  // Values of a field in the document (suggestions for the value box)
  valuesOf(field: string): string[] {
    if (!field || this.isBoolean({ field } as FilterCondition)) return [];
    const values = new Set<string>();
    for (const r of this.rows()) {
      const v = this.store.filterValue(r, field);
      const text = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v ?? '').trim();
      if (text) values.add(text);
      if (values.size >= 60) break;
    }
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  summaryOf(f: NamedFilter): string { return filterText(f.filter); }

  // MARK: - Building
  addCondition(g: FilterGroup): void {
    g.items.push(newCondition(g.items.length === 0 && g === this.draft() ? 'IsTakeoffItem' : 'Name'));
    this.refresh();
  }

  addGroup(g: FilterGroup): void {
    g.items.push({ kind: 'group', id: newFilterId(), logic: 'OR', items: [newCondition('Name')] });
    this.refresh();
  }

  remove(id: string): void {
    const strip = (g: FilterGroup) => {
      g.items = g.items.filter(i => i.id !== id);
      g.items.forEach(i => { if (i.kind === 'group') strip(i); });
    };
    strip(this.draft());
    this.refresh();
  }

  clearAll(): void {
    this.draft.set(emptyFilter());
    this.changed();
  }

  private refresh(): void {
    this.draft.set({ ...this.draft() });
    this.changed();
  }

  // MARK: - Saved filters
  startNew(): void {
    this.selectedId.set(null);
    this.name.set('');
    this.draft.set(emptyFilter());
    this.changed();
  }

  pick(f: NamedFilter): void {
    this.selectedId.set(f.id);
    this.name.set(f.name);
    this.draft.set(structuredClone(f.filter));
    this.changed();
    this.store.setEstimateFilter(clean(this.draft()), f.name);     // preview right away
  }

  save(): void {
    if (this.isPreset()) return;
    const name = this.name().trim() || this.nextName();
    const id = this.canDelete() ? this.selectedId()! : undefined;
    const entry = this.store.saveNamedFilter(name, clean(this.draft()), id);
    this.selectedId.set(entry.id);
    this.name.set(entry.name);
    this.store.showToast(`Saved filter "${entry.name}"`);
  }

  saveAsNew(): void {
    const base = this.name().trim() || this.nextName();
    const used = new Set(this.store.savedFilters.map(f => f.name));
    let name = base, n = 2;
    while (used.has(name)) name = `${base} ${n++}`;
    const entry = this.store.saveNamedFilter(name, clean(this.draft()));
    this.selectedId.set(entry.id);
    this.name.set(entry.name);
    this.store.showToast(`Saved filter "${entry.name}"`);
  }

  deleteSaved(): void {
    const id = this.selectedId();
    if (!id || !this.canDelete()) return;
    this.store.deleteNamedFilter(id);
    this.selectedId.set(null);
  }

  private nextName(): string {
    const used = new Set(this.store.savedFilters.map(f => f.name));
    let n = 1;
    while (used.has(`Filter ${n}`)) n++;
    return `Filter ${n}`;
  }

  // MARK: - Buttons
  apply(): void { this.store.setEstimateFilter(clean(this.draft()), this.name().trim()); }

  ok(): void {
    this.apply();
    this.store.closeFilter();
  }

  cancel(): void {
    this.store.setEstimateFilter(this.original, this.originalName);
    this.store.closeFilter();
  }

  open(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.flt,.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const filter = parseFilter(await file.text());
      if (!filter) {
        this.store.showToast('That file is not a filter', true);
        return;
      }
      this.selectedId.set(null);
      this.name.set(file.name.replace(/\.(flt|json)$/i, ''));
      this.draft.set(filter);
      this.changed();
    });
    input.click();
  }

  exportFile(): void {
    const name = (this.name().trim() || 'filter').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([JSON.stringify(clean(this.draft()), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.flt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  value(event: Event): string { return (event.target as HTMLInputElement | HTMLSelectElement).value; }
  checked(event: Event): boolean { return (event.target as HTMLInputElement).checked; }
}

// Conditions without a field and empty groups are left out (unticked ones are kept, turned off)
function clean(g: FilterGroup): FilterGroup {
  const items: FilterNode[] = [];
  for (const i of g.items) {
    if (i.kind === 'condition') { if (i.field.trim()) items.push({ ...i, field: i.field.trim() }); }
    else {
      const inner = clean(i);
      if (inner.items.length) items.push(inner);
    }
  }
  return { ...g, items };
}
