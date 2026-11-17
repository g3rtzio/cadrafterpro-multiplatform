import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { SlipSheet } from '../../services/slip-sheet/slip-sheet';

// Slip Sheet: every page of the picked PDF and the page of this document it replaces (matched by
// name; any of them can be changed by hand). The markups and measurements stay on the replaced pages.
@Component({
  selector: 'app-slip-sheet-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'slip.cancel()' },
  template: `
    @let s = store.watch();
    @if (slip.request(); as r) {
      <form class="dialog wide slip-dialog" (submit)="$event.preventDefault(); slip.apply()">
        <h2>Slip Sheet</h2>
        <p class="secondary">
          {{ r.fileName }} · {{ r.rows.length }} page{{ r.rows.length === 1 ? '' : 's' }}.
          Pages with the same name are replaced; their markups, measurements and highlights stay.
        </p>
        <div class="slip-actions">
          <button type="button" (click)="slip.rematch()">Match by Name</button>
          <button type="button" (click)="slip.clearAll()">Clear All</button>
          <span class="spacer"></span>
          <span class="secondary small">{{ slip.replaceCount() }} to replace · {{ slip.unmatchedCount() }} without a match</span>
        </div>
        <div class="props-scroll">
          <table class="props-table slip-table">
            <thead><tr><th class="num">#</th><th>New page</th><th>Replaces</th></tr></thead>
            <tbody>
              @for (row of r.rows; track row.source) {
                <tr [class.unmatched]="row.target === null">
                  <td class="num secondary">{{ row.source + 1 }}</td>
                  <td>{{ row.name }}</td>
                  <td>
                    <select (change)="pick(row.source, $event)">
                      <option value="" [selected]="row.target === null">— Don't replace —</option>
                      @for (i of pageIndexes(s.pageCount); track i) {
                        <option [value]="i" [selected]="row.target === i">{{ i + 1 }}. {{ s.pageName(i) }}</option>
                      }
                    </select>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <label class="check-row">
          <input type="checkbox" [checked]="slip.appendUnmatched()" (change)="slip.appendUnmatched.set($any($event.target).checked)" />
          Add the pages without a match at the end (new sheets)
        </label>
        <p class="secondary small">Page changes can't be undone. Save a copy first if you want to keep the old drawings.</p>
        <div class="dialog-buttons">
          <button type="button" (click)="slip.cancel()">Cancel</button>
          <button type="submit" class="primary"
                  [disabled]="slip.busy() || (slip.replaceCount() === 0 && !(slip.appendUnmatched() && slip.unmatchedCount() > 0))">
            {{ slip.busy() ? 'Working…' : 'Replace ' + slip.replaceCount() + ' Page' + (slip.replaceCount() === 1 ? '' : 's') }}
          </button>
        </div>
      </form>
    }
  `,
})
export class SlipSheetDialog {
  readonly store = inject(DrawingStore);
  readonly slip = inject(SlipSheet);

  pageIndexes(count: number): number[] {
    return Array.from({ length: count }, (_, i) => i);
  }

  pick(source: number, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.slip.setTarget(source, value === '' ? null : Number(value));
  }
}
