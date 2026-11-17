import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SCALE_GROUPS } from '../../models/takeoff';
import { DrawingStore, InteractionMode, SplitMode } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// Revu-style bottom bar: view, tools, pages, history, sheet size and scale — port of StatusBarView.swift
@Component({
  selector: 'app-status-bar',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'status-bar', '(document:click)': 'scaleMenuOpen.set(false)' },
  template: `
    @let s = store.watch();
    <!-- Split view -->
    @for (b of splitButtons; track b.mode) {
      <button class="icon-button" [title]="b.title" [class.active]="s.splitMode === b.mode" (click)="s.setSplit(b.mode)">
        <app-icon class="icon" [name]="b.icon" />
      </button>
    }
    <span class="separator"></span>
    <button class="icon-button" title="Fit Page" (click)="s.fitPage()"><app-icon class="icon" name="fit_screen" /></button>
    <button class="icon-button" title="Fit Width" (click)="s.fitWidth()"><app-icon class="icon" name="width" /></button>

    <span class="spacer"></span>

    <!-- Tools -->
    @for (b of toolButtons; track b.mode) {
      <button class="icon-button" [title]="b.title" [class.active]="s.tool === 'none' && s.interaction === b.mode"
              (click)="s.setInteraction(b.mode)">
        <app-icon class="icon" [name]="b.icon" />
      </button>
    }
    <span class="separator"></span>

    <!-- Page navigation -->
    <button class="icon-button" title="First Page" (click)="s.firstPage()"><app-icon class="icon" name="first_page" /></button>
    <button class="icon-button" title="Previous Page" (click)="s.previousPage()"><app-icon class="icon" name="chevron_left" /></button>
    <input class="page-input" [value]="editing() ? draft() : pageText()"
           (focus)="startEditing(); $any($event.target).select()" (input)="draft.set($any($event.target).value)"
           (keydown.enter)="submit($event)" (keydown.escape)="$any($event.target).blur()" (blur)="editing.set(false)" />
    <button class="icon-button" title="Next Page" (click)="s.nextPage()"><app-icon class="icon" name="chevron_right" /></button>
    <button class="icon-button" title="Last Page" (click)="s.lastPage()"><app-icon class="icon" name="last_page" /></button>
    <span class="separator"></span>

    <!-- View history -->
    <button class="icon-button" title="Previous View" [disabled]="!s.canGoBack" (click)="s.goBack()">
      <app-icon class="icon" name="arrow_back" />
    </button>
    <button class="icon-button" title="Next View" [disabled]="!s.canGoForward" (click)="s.goForward()">
      <app-icon class="icon" name="arrow_forward" />
    </button>

    <span class="spacer"></span>

    <!-- Sheet size and scale -->
    <span class="secondary mono">{{ s.pageSizeText(s.currentPageIndex) }}</span>
    <div class="menu-anchor">
      <button class="link-button" (click)="$event.stopPropagation(); scaleMenuOpen.set(!scaleMenuOpen())">
        {{ s.scaleText }} <app-icon class="icon small" name="expand_less" />
      </button>
      @if (scaleMenuOpen()) {
        <div class="menu scale-menu up" (click)="$event.stopPropagation()">
          <button class="menu-item" (click)="setScale(null)">Not Set</button>
          @for (group of scaleGroups; track group.title) {
            <div class="menu-header">{{ group.title }}</div>
            @for (preset of group.presets; track preset.name) {
              <button class="menu-item" (click)="setScale(preset.denominator)">{{ preset.name }}</button>
            }
          }
          <div class="menu-divider"></div>
          <button class="menu-item" (click)="scaleMenuOpen.set(false); s.requestPageScale()">Custom…</button>
        </div>
      }
    </div>
  `,
})
export class StatusBar {
  readonly store = inject(DrawingStore);
  readonly scaleGroups = SCALE_GROUPS;
  readonly scaleMenuOpen = signal(false);
  readonly editing = signal(false);
  readonly draft = signal('');

  readonly splitButtons: { mode: SplitMode; title: string; icon: string }[] = [
    { mode: 'single', title: 'Single View', icon: 'crop_square' },
    { mode: 'vertical', title: 'Split Vertically', icon: 'vertical_split' },
    { mode: 'horizontal', title: 'Split Horizontally', icon: 'horizontal_split' },
  ];
  readonly toolButtons: { mode: InteractionMode; title: string; icon: string }[] = [
    { mode: 'select', title: 'Select', icon: 'arrow_selector_tool' },
    { mode: 'pan', title: 'Pan', icon: 'pan_tool' },
    { mode: 'zoom', title: 'Zoom (⌥ click to zoom out)', icon: 'zoom_in' },
  ];

  // "G-002 (4 of 198)"
  readonly pageText = computed(() => {
    const s = this.store.watch();
    return s.pageCount === 0 ? '' : `${s.pageName(s.currentPageIndex)} (${s.currentPageIndex + 1} of ${s.pageCount})`;
  });

  startEditing(): void {
    this.draft.set(this.pageText());
    this.editing.set(true);
  }

  // Go to a page by typing its number ("4") or its name ("G-002")
  submit(event: Event): void {
    this.store.goToInput(this.draft());
    (event.target as HTMLInputElement).blur();
  }

  setScale(value: number | null): void {
    this.store.scaleDenominator = value;
    this.scaleMenuOpen.set(false);
  }
}
