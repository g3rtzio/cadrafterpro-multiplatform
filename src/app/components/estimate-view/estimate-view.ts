import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ColumnDef } from '../../models/estimate';
import { DrawingStore, EstimateRow } from '../../services/drawing.store';

// One line of the table: a group, an element, or a part (indented under its parent)
interface Line {
  row: EstimateRow;
  depth: number;
  open: boolean;
  canOpen: boolean;
  draggable: boolean; // top-level rows can be moved into and out of groups
}

// "Estimating" tab: every element in the document with its properties (PlanSwift style)
// — port of EstimateView.swift.
// The columns come from the Columns window. Parts hang under their element (sub-items).
// Click selects a row, double-click opens its Properties, Delete removes a part or a group.
// Nothing is grouped by default: "New Group" makes a folder and rows are dragged into it.
// Dragging a row onto the empty part of the table takes it out of its group.
@Component({
  selector: 'app-estimate-view',
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
    <div class="estimate-title">{{ s.fileName || 'Estimate' }}</div>
    @if (lines().length === 0) {
      <div class="estimate-empty">
        <span class="icon big">list_alt</span>
        <div class="estimate-empty-title">No Elements</div>
        <div class="secondary">Measure on the plan or open a PDF with markups.</div>
      </div>
    } @else {
      <table class="estimate-table">
        <thead>
          <tr>
            @for (col of columns(); track col.id) {
              <th [class.num]="col.type === 'number' && col.name !== 'Name'">{{ col.name }}</th>
              @if (col.showUnits) {
                <th>Units</th>
              }
            }
          </tr>
        </thead>
        <tbody>
          @for (line of lines(); track line.row.id) {
            @let row = line.row;
            <tr
              [class.folder-row]="row.isFolder"
              [class.part-row]="row.kind === 'part'"
              [class.selected]="s.selectedEstimateKey === row.key"
              [class.draggable]="line.draggable"
              [attr.draggable]="line.draggable ? 'true' : null"
              [class.drop-target]="dropTarget() === row.id"
              (click)="select(row, $event)"
              (dblclick)="open(row)"
              (dragstart)="dragStart(row, $event)"
              (dragover)="row.isFolder && allowDrop($event, row.id)"
              (dragleave)="dropTarget.set(null)"
              (drop)="row.isFolder && dropOn(row.id, $event)"
            >
              @for (col of columns(); track col.id) {
                @if (col.name === 'Name') {
                  <td class="name-cell" [style.padding-left.px]="12 + line.depth * 20">
                    <span class="chevron" (click)="toggle(row, $event)">
                      @if (line.canOpen) {
                        <span class="icon small">{{
                          line.open ? 'expand_more' : 'chevron_right'
                        }}</span>
                      }
                    </span>
                    @if (row.isFolder) {
                      <span class="icon small secondary">folder</span>
                      @if (editing() === row.id) {
                        <input
                          class="rename"
                          [value]="row.name"
                          (click)="$event.stopPropagation()"
                          (dblclick)="$event.stopPropagation()"
                          (keydown.enter)="rename(row, $event)"
                          (keydown.escape)="editing.set(null)"
                          (keydown.delete)="$event.stopPropagation()"
                          (keydown.backspace)="$event.stopPropagation()"
                          (blur)="rename(row, $event)"
                        />
                      } @else {
                        <b title="Double-click to rename">{{ row.name }}</b>
                        <span class="secondary small"> ({{ row.children.length }})</span>
                        <button
                          class="icon-button inline"
                          title="Delete Group (its rows stay)"
                          (click)="s.deleteEstimateGroup(row.id); $event.stopPropagation()"
                        >
                          <span class="icon small">delete</span>
                        </button>
                      }
                    } @else if (row.kind === 'part') {
                      <span class="icon small secondary">subdirectory_arrow_right</span
                      >{{ row.name }}
                    } @else {
                      <span class="swatch" [style.background]="row.color"></span>{{ row.name }}
                    }
                  </td>
                } @else {
                  @let cell = s.cellValue(row, col);
                  <td
                    [class.num]="col.type === 'number'"
                    [class.qty]="col.name === 'Qty'"
                    [class.secondary]="col.name === 'Pages'"
                  >
                    @if (col.name === 'Color' && !row.isFolder) {
                      <span class="swatch" [style.background]="row.color"></span>
                    }
                    {{ cell.text }}
                  </td>
                }
                @if (col.showUnits) {
                  <td>{{ units(row, col) }}</td>
                }
              }
            </tr>
            @if (row.isFolder && line.open && row.children.length === 0) {
              <tr>
                <td class="secondary small" [style.padding-left.px]="52" [attr.colspan]="span()">
                  Drag elements here
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    }
  `,
})
export class EstimateView {
  readonly store = inject(DrawingStore);
  readonly editing = signal<string | null>(null); // group being renamed
  readonly dropTarget = signal<string | null>(null); // group under the dragged row

  // Reading the store here refreshes the table when something changes on the plan
  readonly columns = computed(() => this.store.watch().visibleColumns);
  readonly span = computed(() => this.columns().reduce((n, c) => n + (c.showUnits ? 2 : 1), 0));

  // Groups, their rows and every sub-item as one flat list (closed rows hide what is below)
  readonly lines = computed(() => {
    const s = this.store.watch();
    const out: Line[] = [];
    const add = (row: EstimateRow, depth: number, draggable: boolean) => {
      const below = row.isFolder ? row.children : row.subRows;
      const open = !s.estimateCollapsed.has(row.id);
      out.push({ row, depth, open, canOpen: row.isFolder || below.length > 0, draggable });
      if (!open) return;
      for (const child of below) add(child, depth + 1, row.isFolder);
    };
    for (const row of s.estimateFolders()) add(row, 0, !row.isFolder);
    return out;
  });

  // Units of a "Units" column: from the property (groups add up only rows with the same units)
  units(row: EstimateRow, col: ColumnDef): string {
    return this.store.cellValue(row, col).units;
  }

  select(row: EstimateRow, event: MouseEvent): void {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).closest<HTMLElement>('app-estimate-view')?.focus();
    this.store.selectEstimateRow(row.key);
  }

  // Double-click: Properties of an element or part; a group is renamed
  open(row: EstimateRow): void {
    if (row.isFolder) this.editing.set(row.id);
    else this.store.openProperties(row.key);
  }

  // Rows and groups start open; Collapse All / Expand All change this set
  toggle(row: EstimateRow, event: MouseEvent): void {
    event.stopPropagation();
    const set = this.store.estimateCollapsed;
    if (set.has(row.id)) set.delete(row.id);
    else set.add(row.id);
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
    event.dataTransfer?.setData('text/plain', row.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  allowDrop(event: DragEvent, groupId: string | null = null): void {
    event.preventDefault();
    if (groupId) event.stopPropagation();
    this.dropTarget.set(groupId);
  }

  // groupId = null: dropped outside every group
  dropOn(groupId: string | null, event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget.set(null);
    const name = event.dataTransfer?.getData('text/plain');
    if (name) this.store.moveToEstimateGroup(name, groupId);
  }
}
