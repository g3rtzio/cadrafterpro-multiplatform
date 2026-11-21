import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { AutoFocus } from '../auto-focus/auto-focus';

// "Save the changes before closing?": shown when a document with changes not saved is closed
// (File > Close, Ctrl+W, the tab's X or the window's X in the desktop app).
// Save writes the file and closes it; Don't Save closes it without saving; Cancel (or Esc) keeps it open.
@Component({
  selector: 'app-save-changes-dialog',
  imports: [AutoFocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'store.answerClose("cancel")' },
  template: `
    @let s = store.watch();
    <div class="dialog" role="alertdialog" aria-labelledby="save-changes-title" aria-describedby="save-changes-text">
      <h2 id="save-changes-title">Save changes?</h2>
      <p id="save-changes-text">Do you want to save the changes you made to <strong>{{ s.closePrompt?.name }}</strong>?</p>
      <p class="secondary small">Your changes will be lost if you don't save them.</p>
      <div class="dialog-buttons">
        <button type="button" style="margin-right: auto" (click)="store.answerClose('discard')">Don't Save</button>
        <button type="button" (click)="store.answerClose('cancel')">Cancel</button>
        <button type="button" class="primary" appAutoFocus (click)="store.answerClose('save')">Save</button>
      </div>
    </div>
  `,
})
export class SaveChangesDialog {
  readonly store = inject(DrawingStore);
}
