import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { EstimateLayouts } from '../../services/estimate-layouts/estimate-layouts';
import { AutoFocus } from '../auto-focus/auto-focus';
import { Icon } from '../icon/icon';

// "Estimating Layouts" panel on the left of the estimate (PlanSwift style).
// Click a layout to show its columns (order, widths) and groups. Change them in the estimate,
// then Save keeps them in the selected layout, or New makes another layout with them.
// Double-click renames. « folds the panel to a thin strip.
@Component({
  selector: 'app-layouts-panel',
  imports: [Icon, AutoFocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'layouts-panel', '[class.collapsed]': 'collapsed()' },
  template: `
    @let l = layouts.watch();
    @let s = store.watch();
    @if (collapsed()) {
      <button class="icon-button layouts-expand" title="Show Estimating Layouts" (click)="setCollapsed(false)">
        <app-icon class="icon small" name="keyboard_double_arrow_right" />
      </button>
      <div class="layouts-vertical-title">Estimating Layouts</div>
    } @else {
      <div class="layouts-header">
        <span class="layouts-title">Estimating Layouts</span>
        <button class="icon-button" title="Hide" (click)="setCollapsed(true)">
          <app-icon class="icon small" name="keyboard_double_arrow_left" />
        </button>
      </div>
      <div class="layouts-toolbar">
        <button class="icon-button" title="Save the current columns in the selected layout"
                [disabled]="!s.hasDocument" (click)="l.save()">
          <app-icon class="icon small accent" name="save" />
        </button>
        <button class="icon-button" title="New layout with the current columns" [disabled]="!s.hasDocument" (click)="l.saveAsNew(); selected.set(l.activeId)">
          <app-icon class="icon small" style="color: #34c759" name="add" />
        </button>
        <button class="icon-button" title="Delete layout" [disabled]="!selected() || l.layouts.length <= 1"
                (click)="remove()">
          <app-icon class="icon small" style="color: #ff3b30" name="close" />
        </button>
        <button class="icon-button" title="Rename" [disabled]="!selected()" (click)="l.startRename(selected()!)">
          <app-icon class="icon small" name="edit" />
        </button>
        <button class="icon-button" title="Move Up" [disabled]="!selected()" (click)="l.move(selected()!, -1)">
          <app-icon class="icon small" name="arrow_upward" />
        </button>
        <button class="icon-button" title="Move Down" [disabled]="!selected()" (click)="l.move(selected()!, 1)">
          <app-icon class="icon small" name="arrow_downward" />
        </button>
        <button class="icon-button" title="Reload the selected layout (drops unsaved column changes)"
                [disabled]="!l.active || !s.hasDocument" (click)="l.apply(l.active!.id)">
          <app-icon class="icon small" name="refresh" />
        </button>
        <button class="icon-button" title="Restore Default, Takeoff View and Cost View" (click)="l.restoreBuiltIns()">
          <app-icon class="icon small" name="restart_alt" />
        </button>
        <button class="icon-button" title="Import layouts (.json)" (click)="l.importLayouts()">
          <app-icon class="icon small accent" name="upload_file" />
        </button>
        <button class="icon-button" title="Export all layouts (.json)" (click)="l.exportLayouts()">
          <app-icon class="icon small accent" name="download" />
        </button>
      </div>
      <div class="layouts-list">
        @for (layout of l.layouts; track layout.id) {
          <div class="tree-row" [class.current]="l.activeId === layout.id" [class.selected]="selected() === layout.id"
               (click)="pick(layout.id)" (dblclick)="l.startRename(layout.id)">
            <app-icon class="icon small secondary" name="view_column" />
            @if (l.renaming === layout.id) {
              <input class="rename" [value]="layout.name" appAutoFocus
                     (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()"
                     (keydown.enter)="rename(layout.id, $event)" (keydown.escape)="l.rename(layout.id, layout.name)"
                     (keydown.delete)="$event.stopPropagation()" (keydown.backspace)="$event.stopPropagation()"
                     (blur)="rename(layout.id, $event)" />
            } @else {
              <span class="name">{{ layout.name }}</span>
              @if (l.activeId === layout.id && l.isModified) {
                <span class="secondary small" title="The columns or groups changed since this layout was loaded. Save to keep them.">modified</span>
              }
            }
          </div>
        }
      </div>
      <div class="layouts-hint secondary small">
        Click a layout to show its columns and groups. Change them in the estimate, then Save.
      </div>
    }
  `,
})
export class LayoutsPanel {
  readonly store = inject(DrawingStore);
  readonly layouts = inject(EstimateLayouts);
  readonly selected = signal<string | null>(this.layouts.activeId);
  readonly collapsed = signal(readFlag());

  pick(id: string): void {
    this.selected.set(id);
    if (this.layouts.renaming) return;
    this.layouts.apply(id);
  }

  rename(id: string, event: Event): void {
    if (this.layouts.renaming !== id) return;
    this.layouts.rename(id, (event.target as HTMLInputElement).value);
  }

  remove(): void {
    const id = this.selected();
    if (!id) return;
    this.layouts.delete(id);
    this.selected.set(null);
  }

  setCollapsed(value: boolean): void {
    this.collapsed.set(value);
    try { localStorage.setItem('layoutsCollapsed', String(value)); } catch { /* not remembered */ }
  }
}

function readFlag(): boolean {
  try { return localStorage.getItem('layoutsCollapsed') === 'true'; } catch { return false; }
}
