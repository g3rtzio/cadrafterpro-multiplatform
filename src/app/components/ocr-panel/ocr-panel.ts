import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { OcrService } from '../../services/ocr/ocr';
import { Icon } from '../icon/icon';

// Floating OCR panel over the plan: progress while reading, the text of the last region
// (editable and copyable), the pages already recognized, a find box over the recognized text
// and the OCR options.
@Component({
  selector: 'app-ocr-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ocr-panel', '(mousedown)': '$event.stopPropagation()' },
  template: `
    @let s = store.watch();
    <div class="ocr-header">
      <app-icon class="icon small accent" name="document_scanner" />
      <strong>OCR</strong>
      <span class="spacer"></span>
      <button class="icon-button" title="Close" (click)="ocr.panelOpen.set(false)"><app-icon class="icon small" name="close" /></button>
    </div>

    <!-- Progress -->
    @if (ocr.progress(); as p) {
      <div class="ocr-section">
        <div class="ocr-status">{{ p.status }} <span class="secondary">{{ percent(p.value) }}</span></div>
        <div class="ocr-bar"><div [style.width.%]="p.value * 100"></div></div>
        <div class="ocr-row"><span class="spacer"></span><button (click)="ocr.cancel()">Cancel</button></div>
      </div>
    }

    <!-- Commands -->
    <div class="ocr-section ocr-row">
      <button [disabled]="!s.hasDocument || ocr.busy()" (click)="ocr.startRegion()" title="Drag a box on the plan">
        <app-icon class="icon small" name="crop_free" /> Region
      </button>
      <button [disabled]="!s.hasDocument || ocr.busy()" (click)="ocr.recognizeCurrentPage()">
        <app-icon class="icon small" name="description" /> Page
      </button>
      <button [disabled]="!s.hasDocument || ocr.busy()" (click)="ocr.recognizeAllPages()">
        <app-icon class="icon small" name="library_books" /> All Pages
      </button>
    </div>

    <!-- Text of the last region -->
    @if (ocr.lastRegion(); as region) {
      <div class="ocr-section">
        <div class="ocr-row">
          <span class="secondary small">Region on {{ s.pageName(ocr.pageIndexOf(region.page)) }} · {{ region.words.length }} words</span>
          <span class="spacer"></span>
          <button [disabled]="!regionText()" (click)="ocr.copy(regionText())"><app-icon class="icon small" name="content_copy" /> Copy</button>
        </div>
        <textarea class="ocr-text" rows="6" spellcheck="false" [value]="region.text"
                  (input)="editedRegion.set($any($event.target).value)"
                  placeholder="No text found"></textarea>
      </div>
    }

    <!-- Pages already recognized -->
    @if (pageResults().length) {
      <div class="ocr-section">
        <div class="ocr-row">
          <span class="secondary small">Recognized pages</span>
          <span class="spacer"></span>
          <button class="link" (click)="ocr.clear()">Clear</button>
        </div>
        @for (r of pageResults(); track r.page) {
          <div class="ocr-row ocr-page">
            <span>{{ s.pageName(ocr.pageIndexOf(r.page)) }}</span>
            <span class="secondary small">{{ r.words.length }} words @if (r.embedded) { · text layer }</span>
            <span class="spacer"></span>
            <button class="icon-button" title="Copy the text of the page" (click)="ocr.copy(r.text)">
              <app-icon class="icon small" name="content_copy" />
            </button>
          </div>
        }
        <!-- Find in the recognized text -->
        <div class="ocr-find">
          <app-icon class="icon small secondary" name="search" />
          <input type="search" placeholder="Find in recognized text" [value]="query()"
                 (input)="query.set($any($event.target).value)" />
        </div>
        @if (query().trim()) {
          <div class="ocr-matches">
            @for (m of matches(); track $index) {
              <button class="ocr-match" (click)="ocr.show(m)">
                <span class="secondary small">{{ s.pageName(m.pageIndex) }}</span>
                <span class="ocr-match-text">{{ m.lineText }}</span>
              </button>
            } @empty {
              <div class="secondary small">No matches</div>
            }
          </div>
        }
      </div>
    }

    <!-- Options -->
    <div class="ocr-section ocr-options">
      <label><input type="checkbox" [checked]="ocr.showHighlights()" (change)="ocr.showHighlights.set(!ocr.showHighlights())" />
        Highlight recognized text</label>
      <label><input type="checkbox" [checked]="ocr.includeVertical()" (change)="ocr.includeVertical.set(!ocr.includeVertical())" />
        Include vertical text (slower)</label>
      <label title="Writes the words into the PDF as invisible text, so the saved file is searchable in any PDF reader">
        <input type="checkbox" [checked]="ocr.makeSearchable()" (change)="ocr.makeSearchable.set(!ocr.makeSearchable())" />
        Make the PDF searchable (on Save)</label>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      right: 12px;
      top: 12px;
      z-index: 15;
      width: 320px;
      max-height: calc(100% - 24px);
      overflow: auto;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
      font-size: 12px;
    }
    .ocr-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .ocr-section { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .ocr-section:last-child { border-bottom: none; }
    .ocr-row { display: flex; align-items: center; gap: 6px; flex-direction: row; }
    .ocr-row button { display: inline-flex; align-items: center; gap: 4px; }
    .ocr-status { font-weight: 500; }
    .ocr-bar { height: 6px; border-radius: 3px; background: var(--hover); overflow: hidden; }
    .ocr-bar div { height: 100%; background: var(--accent); transition: width 0.2s; }
    .ocr-text {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 11px;
    }
    .ocr-page { padding: 2px 0; }
    .ocr-find { display: flex; align-items: center; gap: 4px; }
    .ocr-find input { flex: 1; min-width: 0; }
    .ocr-matches { display: flex; flex-direction: column; max-height: 220px; overflow: auto; }
    .ocr-match {
      display: flex;
      gap: 8px;
      align-items: baseline;
      text-align: left;
      border: none;
      background: none;
      padding: 4px;
      border-radius: 4px;
    }
    .ocr-match:hover { background: var(--hover); }
    .ocr-match-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ocr-options label { display: flex; align-items: center; gap: 6px; }
    button.link { border: none; background: none; color: var(--accent); padding: 0; }
  `,
})
export class OcrPanel {
  readonly store = inject(DrawingStore);
  readonly ocr = inject(OcrService);
  readonly query = signal('');
  readonly editedRegion = signal<string | null>(null);

  readonly pageResults = computed(() => this.ocr.results().filter(r => !r.isRegion)
    .sort((a, b) => this.ocr.pageIndexOf(a.page) - this.ocr.pageIndexOf(b.page)));
  readonly matches = computed(() => { this.ocr.results(); return this.ocr.search(this.query()); });

  // The region text as the user left it (it can be corrected before copying)
  readonly regionText = computed(() => {
    const region = this.ocr.lastRegion();
    const edited = this.editedRegion();
    return edited ?? region?.text ?? '';
  });

  constructor() {
    // A new region result replaces any edit of the previous one
    effect(() => {
      this.ocr.lastRegion();
      untracked(() => this.editedRegion.set(null));
    });
  }

  percent(value: number): string {
    return `${Math.round(value * 100)} %`;
  }
}
