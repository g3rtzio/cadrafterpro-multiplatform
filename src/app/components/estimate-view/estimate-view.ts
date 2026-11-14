import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DrawingStore, EstimateRow, estimateQuantityText } from '../../services/drawing.store';

// "Estimating" tab: every element in the document with its total quantity (PlanSwift style)
// — port of EstimateView.swift.
// Nothing is grouped by default: "New Group" makes a folder and rows are dragged into it.
// Dragging a row onto the empty part of the table takes it out of its group.
@Component({
  selector: 'app-estimate-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'estimate',
    '(dragover)': 'allowDrop($event)',
    '(drop)': 'dropOn(null, $event)',
  },
  template: `
    @let s = store.watch();
    <div class="estimate-title">{{ s.fileName || 'Estimate' }}</div>
    @if (rows().length === 0) {
      <div class="estimate-empty">
        <span class="icon big">list_alt</span>
        <div class="estimate-empty-title">No Elements</div>
        <div class="secondary">Measure on the plan or open a PDF with markups.</div>
      </div>
    } @else {
      <table class="estimate-table">
        <thead>
          <tr>
            <th>Name</th>
            <th class="num">Qty</th>
            <th>Units</th>
            <th>Pages</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
            @if (row.isFolder) {
              @let open = !s.estimateCollapsed.has(row.id);
              <tr
                class="folder-row"
                [class.drop-target]="dropTarget() === row.id"
                (click)="toggle(row)"
                (dragover)="allowDrop($event, row.id)"
                (dragleave)="dropTarget.set(null)"
                (drop)="dropOn(row.id, $event)"
              >
                <td>
                  <span class="icon small">{{ open ? 'expand_more' : 'chevron_right' }}</span>
                  <span class="icon small secondary">folder</span>
                  @if (editing() === row.id) {
                    <input
                      class="rename"
                      [value]="row.name"
                      (click)="$event.stopPropagation()"
                      (keydown.enter)="rename(row, $event)"
                      (keydown.escape)="editing.set(null)"
                      (blur)="rename(row, $event)"
                    />
                  } @else {
                    <b
                      (dblclick)="editing.set(row.id); $event.stopPropagation()"
                      title="Double-click to rename"
                      >{{ row.name }}</b
                    >
                    <span class="secondary small"> ({{ row.children.length }})</span>
                  }
                </td>
                <td></td>
                <td></td>
                <td class="folder-actions">
                  <button
                    class="icon-button"
                    title="Delete Group (its rows stay)"
                    (click)="s.deleteEstimateGroup(row.id); $event.stopPropagation()"
                  >
                    <span class="icon small">delete</span>
                  </button>
                </td>
              </tr>
              @if (open) {
                @for (child of row.children; track child.id) {
                  <tr draggable="true" (dragstart)="dragStart(child, $event)" class="draggable">
                    <td class="indent">
                      <span class="swatch" [style.background]="child.color"></span>{{ child.name }}
                    </td>
                    <td class="num qty">{{ qty(child) }}</td>
                    <td>{{ child.unit }}</td>
                    <td class="secondary">{{ child.pages }}</td>
                  </tr>
                }
                @if (row.children.length === 0) {
                  <tr>
                    <td class="indent secondary small" colspan="4">Drag elements here</td>
                  </tr>
                }
              }
            } @else {
              <tr draggable="true" (dragstart)="dragStart(row, $event)" class="draggable">
                <td><span class="swatch" [style.background]="row.color"></span>{{ row.name }}</td>
                <td class="num qty">{{ qty(row) }}</td>
                <td>{{ row.unit }}</td>
                <td class="secondary">{{ row.pages }}</td>
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
  // Reading the store here refreshes the table when something changes on the plan
  readonly rows = computed(() => this.store.watch().estimateFolders());
  readonly editing = signal<string | null>(null); // group being renamed
  readonly dropTarget = signal<string | null>(null); // group under the dragged row

  qty(row: EstimateRow): string {
    return estimateQuantityText(row);
  }

  // Groups start open; Collapse All / Expand All change this set
  toggle(folder: EstimateRow): void {
    const set = this.store.estimateCollapsed;
    if (set.has(folder.id)) set.delete(folder.id);
    else set.add(folder.id);
    this.store.touch();
  }

  rename(folder: EstimateRow, event: Event): void {
    if (this.editing() !== folder.id) return;
    this.editing.set(null);
    this.store.renameEstimateGroup(folder.id, (event.target as HTMLInputElement).value);
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
