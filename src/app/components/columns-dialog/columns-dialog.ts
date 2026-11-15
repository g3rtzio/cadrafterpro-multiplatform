import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ColumnDef, PropType } from '../../models/estimate';
import { DrawingStore } from '../../services/drawing.store';

// Columns window of the estimate (PlanSwift style): the list of columns, each one a property
// shown for every row. Columns can be added, edited, reordered, hidden and deleted.
@Component({
  selector: 'app-columns-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.closeColumns()' },
  template: `
    <div class="dialog wide">
      <h2>Columns</h2>
      <div class="props-toolbar">
        <button class="icon-button" title="New Column" (click)="add()">
          <span class="icon">add</span>
        </button>
        <button class="icon-button" title="Move Up" [disabled]="!canMove(-1)" (click)="move(-1)">
          <span class="icon">arrow_upward</span>
        </button>
        <button class="icon-button" title="Move Down" [disabled]="!canMove(1)" (click)="move(1)">
          <span class="icon">arrow_downward</span>
        </button>
        <button
          class="icon-button"
          title="Delete Column"
          [disabled]="selected() === null"
          (click)="remove()"
        >
          <span class="icon">delete</span>
        </button>
        <span class="secondary small">The name of a column is the property it shows</span>
      </div>
      <div class="props-scroll">
        <table class="props-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Data Type</th>
              <th class="center">Visible</th>
              <th class="center">Show Units</th>
              <th>Decimals</th>
            </tr>
          </thead>
          <tbody>
            @for (col of draft(); track col.id; let i = $index) {
              <tr [class.selected]="selected() === i" (click)="selected.set(i)">
                <td>
                  <input
                    list="column-names"
                    [value]="col.name"
                    (input)="patch(i, { name: text($event) })"
                  />
                </td>
                <td>
                  <select (change)="patch(i, { type: $any(text($event)) })">
                    @for (t of types; track t) {
                      <option [value]="t" [selected]="col.type === t">
                        {{ t === 'number' ? 'Number' : 'Text' }}
                      </option>
                    }
                  </select>
                </td>
                <td class="center">
                  <input
                    type="checkbox"
                    [checked]="col.visible"
                    (change)="patch(i, { visible: checked($event) })"
                  />
                </td>
                <td class="center">
                  <input
                    type="checkbox"
                    [checked]="col.showUnits"
                    (change)="patch(i, { showUnits: checked($event) })"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    max="8"
                    class="num-input"
                    [value]="col.decimals"
                    [disabled]="col.type !== 'number'"
                    (input)="
                      patch(i, {
                        decimals: Math.max(0, Math.min(8, Math.round(+text($event) || 0))),
                      })
                    "
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <datalist id="column-names">
        @for (name of store.knownPropertyNames; track name) {
          <option [value]="name"></option>
        }
      </datalist>
      @if (error()) {
        <p class="error-text">{{ error() }}</p>
      }
      <div class="dialog-buttons">
        <button type="button" (click)="store.closeColumns()">Cancel</button>
        <button type="button" class="primary" [disabled]="!!error()" (click)="ok()">Ok</button>
      </div>
    </div>
  `,
})
export class ColumnsDialog {
  readonly store = inject(DrawingStore);
  readonly types: PropType[] = ['number', 'text'];
  readonly Math = Math;
  readonly draft = signal<ColumnDef[]>(structuredClone(this.store.estimate.columns));
  readonly selected = signal<number | null>(null);

  readonly error = computed(() => {
    const names = this.draft().map((c) => c.name.trim().toLowerCase());
    if (names.some((n) => !n)) return 'Every column needs a name';
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    return twice ? `The column "${twice}" is in the list twice` : '';
  });

  text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  patch(index: number, change: Partial<ColumnDef>): void {
    this.draft.update((list) =>
      list.map((c, i) => {
        if (i !== index) return c;
        const next = { ...c, ...change };
        // A known property brings its usual type (Name, Description… are text)
        if (
          change.name !== undefined &&
          [
            'name',
            'pages',
            'color',
            'description',
            'type',
            'item #',
            'cost type',
            'division',
            'subdivision',
            'phase',
            'cost code',
          ].includes(change.name.trim().toLowerCase())
        )
          next.type = 'text';
        return next;
      }),
    );
  }

  add(): void {
    const id = `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const at = (this.selected() ?? this.draft().length - 1) + 1;
    this.draft.update((list) => {
      const next = [...list];
      next.splice(at, 0, {
        id,
        name: '',
        type: 'number',
        visible: true,
        showUnits: false,
        decimals: 2,
      });
      return next;
    });
    this.selected.set(at);
  }

  canMove(step: number): boolean {
    const i = this.selected();
    return i !== null && i + step >= 0 && i + step < this.draft().length;
  }

  move(step: number): void {
    const i = this.selected();
    if (i === null || !this.canMove(step)) return;
    this.draft.update((list) => {
      const next = [...list];
      [next[i], next[i + step]] = [next[i + step], next[i]];
      return next;
    });
    this.selected.set(i + step);
  }

  remove(): void {
    const i = this.selected();
    if (i === null) return;
    this.draft.update((list) => list.filter((_, n) => n !== i));
    this.selected.set(null);
  }

  ok(): void {
    if (this.error()) return;
    this.store.applyColumns(this.draft().map((c) => ({ ...c, name: c.name.trim() })));
  }
}
