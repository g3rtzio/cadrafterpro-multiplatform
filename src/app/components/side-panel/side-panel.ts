import { ChangeDetectionStrategy, Component, model, signal, viewChild } from '@angular/core';
import { PropertiesPanel } from '../properties-panel/properties-panel';
import { ScalePanel } from '../scale-panel/scale-panel';
import { SearchPanel } from '../search-panel/search-panel';

export type SidePanelTab = 'settings' | 'search' | 'scale';

// Right side bar like Bluebeam Revu: a column of icons on the edge (Settings, Search, Scale)
// and the panel of the chosen one. Clicking the open panel's icon again hides the panel.
// ⌘F / Ctrl+F opens Search.
@Component({
  selector: 'app-side-panel',
  imports: [PropertiesPanel, ScalePanel, SearchPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'side-panel', '(document:keydown)': 'onKey($event)' },
  template: `
    @if (open()) {
      <aside class="side-panel-body">
        <header class="side-panel-title">{{ titles[tab()] }}</header>
        <div class="side-panel-content">
          @switch (tab()) {
            @case ('settings') { <app-properties-panel /> }
            @case ('search') { <app-search-panel /> }
            @case ('scale') { <app-scale-panel /> }
          }
        </div>
      </aside>
    }
    <nav class="side-strip">
      @for (b of buttons; track b.tab) {
        <button class="strip-button" [class.active]="open() && tab() === b.tab" [title]="b.title" (click)="toggle(b.tab)">
          <span class="icon">{{ b.icon }}</span>
        </button>
      }
    </nav>
  `,
  styles: [`
    :host { display: flex; flex: none; min-height: 0; background: var(--bar); border-left: 1px solid var(--border); }
    .side-panel-body { width: 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
    .side-panel-title { padding: 8px 12px 4px; font-weight: 600; font-size: 13px; }
    .side-panel-content { flex: 1; overflow-y: auto; min-height: 0; }
    .side-strip { width: 40px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 6px; }
    .strip-button {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
    }
    .strip-button.active { background: var(--accent); color: #fff; }
    .strip-button.active:hover { background: var(--accent) !important; }
  `],
})
export class SidePanel {
  // Panel shown (the title bar button toggles it too)
  readonly open = model(true);
  readonly tab = signal<SidePanelTab>('settings');
  private readonly searchPanel = viewChild(SearchPanel);

  readonly titles: Record<SidePanelTab, string> = { settings: 'Properties', search: 'Search', scale: 'Scale' };
  readonly buttons: { tab: SidePanelTab; icon: string; title: string }[] = [
    { tab: 'settings', icon: 'settings', title: 'Settings (Properties)' },
    { tab: 'search', icon: 'search', title: 'Search (⌘F)' },
    { tab: 'scale', icon: 'straighten', title: 'Scale' },
  ];

  toggle(tab: SidePanelTab): void {
    if (this.open() && this.tab() === tab) {
      this.open.set(false);
      return;
    }
    this.tab.set(tab);
    this.open.set(true);
    if (tab === 'search') setTimeout(() => this.searchPanel()?.focusField(), 0);
  }

  onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.tab.set('search');
      this.open.set(true);
      setTimeout(() => this.searchPanel()?.focusField(), 0);
    }
  }
}
