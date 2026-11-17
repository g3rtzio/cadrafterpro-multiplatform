import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  FILTER_LOGICS, FILTER_OPS, FILTER_SPECIAL_FIELDS, FilterCondition, FilterGroup, FilterNode, emptyFilter, filterText,
  newCondition, newFilterId, parseFilter,
} from '../../models/estimate-filter';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// Filter builder of the estimate (like PlanSwift's): a tree of conditions joined by AND / OR.
// Click the logic of a group to change it, "+" adds a condition or a group, the fields are the
// properties of the document (and IsTakeoffItem, IsPart, Name, Type, Pages, Color).
// Open… / Save As… read and write the filter as a .flt file. Apply shows the result and keeps
// the window open; OK applies and closes; Cancel leaves the estimate as it was.
@Component({
  selector: 'app-filter-builder',
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'cancel()' },
  styles: [`
    .filter-tree { min-height: 220px; max-height: 50vh; overflow: auto; padding: 8px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--panel); font-size: 13px; }
    .node { display: flex; align-items: center; gap: 6px; padding: 2px 0; flex-wrap: wrap; }
    .children { margin-left: 22px; padding-left: 10px; border-left: 1px dotted var(--border); }
    .logic { color: #d93025; font-weight: 600; }
    .root-label { font-weight: 600; }
    select, input { font-size: 12px; }
    .field { color: #1f9d55; }
    .op { color: #a0337a; }
    .value { width: 140px; }
    .summary { font-size: 12px; color: var(--secondary); margin: 6px 0 0; min-height: 16px; }
    .add-hint { font-size: 12px; color: var(--secondary); }
    .dialog-buttons .left { margin-right: auto; display: flex; gap: 6px; }
  `],
  template: `
    <div class="dialog wide" (click)="$event.stopPropagation()">
      <h2><app-icon class="icon" name="filter_alt" /> Filter Builder{{ fileName() ? ' - [' + fileName() + ']' : '' }}</h2>
      <div class="filter-tree">
        <ng-container *ngTemplateOutlet="groupTpl; context: { $implicit: draft(), root: true }" />
      </div>
      <p class="summary">{{ summary() }}</p>
      <datalist id="filter-fields">
        @for (f of fields(); track f) { <option [value]="f"></option> }
      </datalist>
      <div class="dialog-buttons">
        <span class="left">
          <button type="button" (click)="open()">Open…</button>
          <button type="button" (click)="saveAs()">Save As…</button>
        </span>
        <button type="button" (click)="ok()" class="primary">OK</button>
        <button type="button" (click)="cancel()">Cancel</button>
        <button type="button" (click)="apply()">Apply</button>
      </div>
    </div>

    <!-- A group: its logic, then its conditions and groups -->
    <ng-template #groupTpl let-g let-root="root">
      <div class="node">
        @if (root) { <span class="root-label">Filter</span> }
        <select class="logic" [value]="g.logic" (change)="g.logic = $any(value($event)); changed()">
          @for (l of logics; track l) { <option [value]="l" [selected]="g.logic === l">{{ l }}</option> }
        </select>
        <span class="secondary">@if (root) { &lt;root&gt; } @else { &lt;group&gt; }</span>
        <button class="icon-button" title="Add a condition" (click)="addCondition(g)"><app-icon class="icon small" name="add" /></button>
        <button class="icon-button" title="Add a group (its conditions are joined with their own AND / OR)" (click)="addGroup(g)">
          <app-icon class="icon small" name="account_tree" />
        </button>
        @if (!root) {
          <button class="icon-button" title="Remove this group" (click)="remove(g.id)"><app-icon class="icon small" name="close" /></button>
        }
      </div>
      <div class="children">
        @for (item of g.items; track item.id) {
          @if (item.kind === 'group') {
            <ng-container *ngTemplateOutlet="groupTpl; context: { $implicit: item, root: false }" />
          } @else {
            <div class="node">
              <input class="field" list="filter-fields" [value]="item.field" placeholder="Property"
                     (change)="item.field = value($event); changed()" />
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
                  <input class="value" [value]="item.value" placeholder="Value" (input)="item.value = value($event); changed()" />
                }
              }
              <button class="icon-button" title="Remove this condition" (click)="remove(item.id)"><app-icon class="icon small" name="close" /></button>
            </div>
          }
        } @empty {
          <div class="add-hint">Press + to add a new condition</div>
        }
      </div>
    </ng-template>
  `,
})
export class FilterBuilder {
  readonly store = inject(DrawingStore);
  readonly ops = FILTER_OPS;
  readonly logics = FILTER_LOGICS;
  // Copy being edited (the estimate changes only on Apply / OK)
  readonly draft = signal<FilterGroup>(structuredClone(this.store.estimateFilter) ?? emptyFilter());
  private readonly rev = signal(0);
  readonly fileName = signal('');
  // What the estimate showed before: Cancel goes back to it
  private readonly original = this.store.estimateFilter ? structuredClone(this.store.estimateFilter) : null;

  readonly fields = computed(() => {
    const names = this.store.watch().knownPropertyNames.filter(n => !FILTER_SPECIAL_FIELDS.includes(n));
    return [...FILTER_SPECIAL_FIELDS, ...names];
  });

  readonly summary = computed(() => {
    this.rev();
    const text = filterText(this.draft());
    return text ? `Shows: ${text}` : 'No conditions: every row is shown';
  });

  changed(): void { this.rev.update(v => v + 1); }

  isBoolean(c: FilterCondition): boolean { return c.field === 'IsTakeoffItem' || c.field === 'IsPart'; }

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

  private refresh(): void {
    this.draft.set({ ...this.draft() });
    this.changed();
  }

  apply(): void { this.store.setEstimateFilter(clean(this.draft())); }

  ok(): void {
    this.apply();
    this.store.closeFilter();
  }

  cancel(): void {
    this.store.setEstimateFilter(this.original);
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
      this.draft.set(filter);
      this.fileName.set(file.name);
      this.changed();
    });
    input.click();
  }

  saveAs(): void {
    const name = (this.fileName() || 'filter.flt').replace(/\.(json)$/i, '.flt');
    const blob = new Blob([JSON.stringify(clean(this.draft()), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.flt$/i.test(name) ? name : `${name}.flt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.fileName.set(a.download);
  }

  value(event: Event): string { return (event.target as HTMLInputElement | HTMLSelectElement).value; }
}

// Conditions without a field and empty groups don't count
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
