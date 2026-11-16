import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { COLORS } from '../../models/takeoff';
import { AI_PROVIDERS, AiAssistant, AiDetail, AiProvider } from '../../services/ai-assistant/ai-assistant';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// AI panel of the right side bar: a form to connect Claude, ChatGPT or Gemini (with the user's
// own API key) and let the AI count the chosen takeoff items on the drawing. The counts are
// added straight into the document with each item's name and color (Undo removes them).
@Component({
  selector: 'app-ai-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties' },
  template: `
    @let s = store.watch();
    @let info = ai.info();

    <!-- 1. Connection -->
    <section class="panel-section">
      <h3>AI Provider</h3>
      <div class="segmented">
        @for (p of providers; track p.id) {
          <button [class.active]="ai.provider() === p.id" (click)="setProvider(p.id)">{{ p.name }}</button>
        }
      </div>
      <label class="field">API key
        <div class="key-row">
          <input [type]="showKey() ? 'text' : 'password'" autocomplete="off" spellcheck="false"
                 [placeholder]="info.keyHint" [value]="ai.apiKey()" (change)="ai.setApiKey(value($event))" />
          <button class="icon-button" [title]="showKey() ? 'Hide key' : 'Show key'" (click)="showKey.set(!showKey())">
            <app-icon class="icon small" [name]="showKey() ? 'visibility_off' : 'visibility'" />
          </button>
        </div>
      </label>
      <div class="secondary small">
        Get a key at <a [href]="info.keyUrl" target="_blank" rel="noopener">{{ keyHost(info.keyUrl) }}</a>.
        A Claude Pro or ChatGPT Plus subscription doesn't include API access; the key is billed per use.
      </div>
      <label class="field">Model
        <input [attr.list]="'ai-models-' + info.id" [value]="ai.model()" (change)="ai.setModel(value($event))" />
        <datalist [id]="'ai-models-' + info.id">
          @for (m of info.models; track m) { <option [value]="m"></option> }
        </datalist>
      </label>
      <label class="check"><input type="checkbox" [checked]="ai.remember()" (change)="ai.setRemember(checked($event))" />
        Remember the key on this computer</label>
      <div class="row-buttons">
        <button [disabled]="ai.busy() || !ai.apiKey()" (click)="ai.testConnection()">Test Connection</button>
        <button [disabled]="!ai.apiKey()" (click)="ai.forgetKey()">Disconnect</button>
      </div>
      @if (ai.status(); as st) {
        <div class="status" [class.ok]="st.ok" [class.bad]="!st.ok">
          <app-icon class="icon small" [name]="st.ok ? 'check_circle' : 'error'" /> {{ st.text }}
        </div>
      }
      <div class="secondary small">The key stays in this browser and is sent only to {{ info.name }}. The AI sees the pictures and text of the pages you count.</div>
    </section>

    <!-- 2. Takeoff items to count -->
    <section class="panel-section">
      <h3>Count Takeoff Items</h3>
      @for (item of countItems(); track item.id) {
        <label class="item-row">
          <input type="checkbox" [checked]="isPicked(item.id)" (change)="pick(item.id, checked($event))" />
          <span class="swatch" [style.background]="item.color"></span>
          <span class="item-name">{{ item.name }}</span>
          <span class="secondary small">{{ countOf(item.id) }} ea</span>
        </label>
      } @empty {
        <div class="secondary small">No count items yet. Add one below (for example "Duplex Outlet" or "Door D1").</div>
      }
      <div class="new-item">
        <input type="text" placeholder="New count item" [value]="newName()" (input)="newName.set(value($event))"
               (keydown.enter)="addItem(newColors[0])" />
        @for (c of newColors; track c) {
          <button class="color-dot" [style.background]="c" title="Add a count item in this color" (click)="addItem(c)"></button>
        }
      </div>

      <label class="field">What to look for (optional)
        <textarea rows="3" [value]="instructions()" (input)="instructions.set(value($event))"
                  placeholder="e.g. Duplex Outlet = circle with two lines; Door D1 = the D1 tags on the floor plan"></textarea>
      </label>
      <label class="field">Pages
        <select (change)="pages.set(value($event) === 'all' ? 'all' : 'current')">
          <option value="current" [selected]="pages() === 'current'">Current page ({{ s.hasDocument ? s.pageName(s.currentPageIndex) : '—' }})</option>
          <option value="all" [selected]="pages() === 'all'">All pages ({{ s.pageCount }})</option>
        </select>
      </label>
      <label class="field">Detail
        <select (change)="detail.set(+value($event) === 3 ? 3 : +value($event) === 2 ? 2 : 1)">
          <option value="1" [selected]="detail() === 1">Normal (whole sheet, 1 picture)</option>
          <option value="2" [selected]="detail() === 2">High (4 pictures, small symbols)</option>
          <option value="3" [selected]="detail() === 3">Maximum (9 pictures, large sheets)</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" [checked]="sendText()" (change)="sendText.set(checked($event))" />
        Send the text of the page (tags and labels are placed exactly)</label>

      @if (ai.busy()) {
        <div class="busy"><span class="spinner"></span> {{ ai.progress() }}</div>
        <button (click)="ai.cancel()">Stop</button>
      } @else {
        <button class="primary" [disabled]="!canRun()" (click)="run()">
          <app-icon class="icon small" name="auto_awesome" /> Count and Add to Drawing
        </button>
      }
      @if (!s.hasDocument) { <div class="secondary small">Open a drawing first.</div> }
      @if (ai.error()) { <div class="status bad"><app-icon class="icon small" name="error" /> {{ ai.error() }}</div> }
    </section>

    <!-- 3. What was added -->
    @if (ai.results().length) {
      <section class="panel-section">
        <h3>Added to the Drawing</h3>
        @for (r of ai.results(); track r.pageIndex) {
          <div class="result-page">{{ s.pageName(r.pageIndex) }}</div>
          @for (a of r.added; track a.name) {
            <div class="item-row">
              <span class="swatch" [style.background]="a.color"></span>
              <span class="item-name">{{ a.name }}</span>
              <span>{{ a.count }} ea</span>
            </div>
          }
          @if (r.skipped) { <div class="secondary small">{{ r.skipped }} already counted, skipped.</div> }
          @if (r.notes) { <div class="notes">{{ r.notes }}</div> }
        }
        <div class="secondary small">Check the counts on the plan; Undo (⌘Z) removes them.</div>
      </section>
    }
  `,
  styles: [`
    .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .segmented button { flex: 1; border: none; border-radius: 0; background: transparent; padding: 4px 0; }
    .segmented button + button { border-left: 1px solid var(--border); }
    .segmented button.active { background: var(--accent); color: #fff; }
    .key-row { display: flex; align-items: center; gap: 2px; }
    .key-row input { flex: 1; min-width: 0; }
    .check { display: flex; align-items: flex-start; gap: 6px; }
    .check input { margin-top: 2px; }
    .status { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    .status.ok { color: #1f9d55; }
    .status.bad { color: #d93025; }
    .item-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    .item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .new-item { display: flex; align-items: center; gap: 4px; }
    .new-item input { flex: 1; min-width: 0; }
    .color-dot { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.2); flex: none; }
    textarea { resize: vertical; font: inherit; }
    .busy { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .spinner { width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%;
      animation: spin 0.8s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .result-page { font-weight: 600; font-size: 12px; margin-top: 4px; }
    .notes { font-size: 12px; white-space: pre-wrap; padding: 6px; border-radius: 6px; background: var(--panel); border: 1px solid var(--border); }
    button.primary { display: flex; align-items: center; justify-content: center; gap: 4px; }
  `],
})
export class AiPanel {
  readonly store = inject(DrawingStore);
  readonly ai = inject(AiAssistant);
  readonly providers = AI_PROVIDERS;
  readonly newColors = [COLORS.red, COLORS.orange, COLORS.green, COLORS.blue, COLORS.purple];

  readonly showKey = signal(false);
  readonly picked = signal<ReadonlySet<string>>(new Set());
  readonly newName = signal('');
  readonly instructions = signal('');
  readonly pages = signal<'current' | 'all'>('current');
  readonly detail = signal<AiDetail>(2);
  readonly sendText = signal(true);

  countItems() {
    return this.store.watch().items.filter(i => i.kind === 'count');
  }

  countOf(itemId: string): number {
    return this.store.measurements.filter(m => m.itemId === itemId).reduce((n, m) => n + m.points.length, 0);
  }

  isPicked(id: string): boolean { return this.picked().has(id); }

  pick(id: string, on: boolean): void {
    const next = new Set(this.picked());
    if (on) next.add(id); else next.delete(id);
    this.picked.set(next);
  }

  // New count takeoff item, ticked for the next run
  addItem(color: string): void {
    const s = this.store;
    const name = this.newName().trim();
    if (!name) return;
    s.addItem(name, 'count', color);
    const item = s.items[s.items.length - 1];
    s.cancelTool();                       // addItem starts measuring with it; here the AI places the counts
    s.touch();
    this.pick(item.id, true);
    this.newName.set('');
  }

  canRun(): boolean {
    const ids = this.countItems().map(i => i.id).filter(id => this.picked().has(id));
    return this.store.hasDocument && !!this.ai.apiKey() && ids.length > 0;
  }

  run(): void {
    const s = this.store;
    const ids = this.countItems().map(i => i.id).filter(id => this.picked().has(id));
    const pages = this.pages() === 'all' ? Array.from({ length: s.pageCount }, (_, i) => i) : [s.currentPageIndex];
    void this.ai.countItems(ids, pages, this.instructions(), this.detail(), this.sendText());
  }

  setProvider(p: AiProvider): void {
    this.showKey.set(false);
    this.ai.setProvider(p);
  }

  keyHost(url: string): string { return new URL(url).host; }
  value(e: Event): string { return (e.target as HTMLInputElement).value; }
  checked(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
}
