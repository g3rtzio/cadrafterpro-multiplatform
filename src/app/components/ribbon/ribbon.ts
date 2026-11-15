import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { COLORS, SCALE_GROUPS, TakeoffKind, kindIcon, kindTitle } from '../../models/takeoff';
import { DrawingStore, RibbonTab } from '../../services/drawing.store';

// Ribbon-style top bar with tabs (Home, Estimating) — port of RibbonView.swift
@Component({
  selector: 'app-ribbon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ribbon', '(document:click)': 'openMenu.set(null)' },
  template: `
    @let s = store.watch();
    <!-- Row of tabs -->
    <div class="ribbon-tabs">
      @for (tab of tabs; track tab) {
        <button class="ribbon-tab" [class.active]="s.ribbonTab === tab" (click)="s.showTab(tab)">
          {{ tab }}
        </button>
      }
    </div>

    <div class="ribbon-tools">
      <!-- File group (both tabs): Open File, Save (⌘S), Save As (⇧⌘S), Close -->
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <button class="ribbon-button" title="Open File (⌘O)" (click)="openFile.emit()">
            <span class="icon accent">folder_open</span><span>Open File</span>
          </button>
          <button
            class="ribbon-button"
            title="Save (⌘S)"
            [disabled]="!s.hasDocument"
            (click)="s.save()"
          >
            <span class="icon accent">save</span><span>Save</span>
          </button>
          <button
            class="ribbon-button"
            title="Save As (⇧⌘S)"
            [disabled]="!s.hasDocument"
            (click)="s.saveAs()"
          >
            <span class="icon accent">save_as</span><span>Save As</span>
          </button>
          <button
            class="ribbon-button"
            title="Close File"
            [disabled]="!s.hasDocument"
            (click)="s.closeDocument()"
          >
            <span class="icon accent">close</span><span>Close</span>
          </button>
        </div>
        <div class="ribbon-group-title">File</div>
      </div>

      @if (s.ribbonTab === 'Home') {
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <!-- Scale: opens a list of scales -->
            <div class="menu-anchor">
              <button class="ribbon-button" title="Scale" (click)="toggleMenu('scale', $event)">
                <span class="icon">straighten</span><span>Scale</span>
              </button>
              @if (openMenu() === 'scale') {
                <div class="menu scale-menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="setScale(null)">
                    Not Set
                    @if (s.scaleDenominator === null) {
                      <span class="check">✓</span>
                    }
                  </button>
                  @for (group of scaleGroups; track group.title) {
                    <div class="menu-header">{{ group.title }}</div>
                    @for (preset of group.presets; track preset.name) {
                      <button class="menu-item" (click)="setScale(preset.denominator)">
                        {{ preset.name }}
                        @if (s.scaleDenominator === preset.denominator) {
                          <span class="check">✓</span>
                        }
                      </button>
                    }
                  }
                  <div class="menu-divider"></div>
                  <button class="menu-item" (click)="openMenu.set(null); s.requestPageScale()">
                    Custom…
                  </button>
                </div>
              }
            </div>
            <button
              class="ribbon-button"
              title="Dimension"
              [class.active]="s.selectedItem?.name === 'Dimension'"
              (click)="s.startDimension()"
            >
              <span class="icon" [style.color]="colors.blue">straighten</span><span>Dimension</span>
            </button>
            <!-- Snap: measuring clicks jump to the vertices of the drawing -->
            <button
              class="ribbon-button"
              title="Snap"
              [class.active]="s.snapEnabled"
              (click)="s.snapEnabled = !s.snapEnabled"
            >
              <span class="icon" [style.color]="colors.green">my_location</span><span>Snap</span>
            </button>
          </div>
          <div class="ribbon-group-title">Measure</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            @for (t of takeoffs; track t.kind) {
              <!-- Takeoff button: click = continue with the last item of that type,
                   arrow = pick another item or create a new one -->
              <div
                class="menu-anchor ribbon-split"
                [class.active]="s.activeKind === t.kind && s.selectedItem?.name !== 'Dimension'"
              >
                <button
                  class="ribbon-button"
                  [title]="title(t.kind)"
                  (click)="s.startTakeoff(t.kind)"
                >
                  <span class="icon" [style.color]="t.color">{{ icon(t.kind) }}</span><span>{{
                    title(t.kind)
                  }}</span>
                </button>
                <button class="ribbon-arrow" (click)="toggleMenu(t.kind, $event)">
                  <span class="icon small">expand_more</span>
                </button>
                @if (openMenu() === t.kind) {
                  <div class="menu" (click)="$event.stopPropagation()">
                    <button class="menu-item" (click)="openMenu.set(null); s.newTakeoff(t.kind)">
                      New {{ title(t.kind) }}
                    </button>
                    @if (s.takeoffItems(t.kind).length) {
                      <div class="menu-divider"></div>
                      @for (item of s.takeoffItems(t.kind); track item.id) {
                        <button class="menu-item" (click)="openMenu.set(null); s.select(item.id)">
                          <span class="swatch" [style.background]="item.color"></span
                          >{{ item.name }}
                        </button>
                      }
                    }
                  </div>
                }
              </div>
            }
          </div>
          <div class="ribbon-group-title">Takeoff</div>
        </div>
      } @else {
        <!-- Estimating tab: groups, export, parts, properties and columns -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button
              class="ribbon-button"
              title="New Group"
              [disabled]="!s.hasDocument"
              (click)="s.newEstimateGroup()"
            >
              <span class="icon accent">create_new_folder</span><span>New Group</span>
            </button>
            <button class="ribbon-button" (click)="s.estimateCollapsed.clear(); s.touch()">
              <span class="icon">unfold_more</span><span>Expand All</span>
            </button>
            <button class="ribbon-button" (click)="collapseAll()">
              <span class="icon">unfold_less</span><span>Collapse All</span>
            </button>
            <button
              class="ribbon-button"
              title="Export to Excel (.xlsx)"
              [disabled]="!s.hasDocument"
              (click)="s.exportExcel()"
            >
              <span class="icon" [style.color]="colors.green">table_view</span
              ><span>Export to Excel</span>
            </button>
          </div>
          <div class="ribbon-group-title">Estimate</div>
        </div>

        <!-- Parts: estimate lines without a measurement; "As Sub-Item" hangs it under the selected row -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <div class="menu-anchor ribbon-split">
              <button
                class="ribbon-button"
                title="New Part"
                [disabled]="!s.hasDocument"
                (click)="s.newPart(false)"
              >
                <span class="icon" [style.color]="colors.orange">add_box</span><span>New Part</span>
              </button>
              <button
                class="ribbon-arrow"
                [disabled]="!s.hasDocument"
                (click)="toggleMenu('part', $event)"
              >
                <span class="icon small">expand_more</span>
              </button>
              @if (openMenu() === 'part') {
                <div class="menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="openMenu.set(null); s.newPart(false)">
                    New Part
                  </button>
                  <button
                    class="menu-item"
                    [disabled]="!s.canAddSubItem"
                    (click)="openMenu.set(null); s.newPart(true)"
                  >
                    As Sub-Item
                  </button>
                </div>
              }
            </div>
            <button
              class="ribbon-button"
              title="Properties of the selected row"
              [disabled]="!s.canAddSubItem"
              (click)="s.openProperties()"
            >
              <span class="icon">tune</span><span>Properties</span>
            </button>
            <button
              class="ribbon-button"
              title="Delete the selected part or group"
              [disabled]="!s.selectedEstimateKey"
              (click)="s.deleteEstimateSelection()"
            >
              <span class="icon" [style.color]="colors.red">delete</span><span>Delete</span>
            </button>
            <button
              class="ribbon-button"
              title="Columns of the estimate"
              [disabled]="!s.hasDocument"
              (click)="s.openColumns()"
            >
              <span class="icon">view_column</span><span>Columns</span>
            </button>
          </div>
          <div class="ribbon-group-title">Items</div>
        </div>
      }
    </div>
  `,
})
export class Ribbon {
  readonly store = inject(DrawingStore);
  readonly openFile = output<void>();
  readonly openMenu = signal<string | null>(null);
  readonly tabs: RibbonTab[] = ['Home', 'Estimating'];
  readonly scaleGroups = SCALE_GROUPS;
  readonly colors = COLORS;
  readonly takeoffs: { kind: TakeoffKind; color: string }[] = [
    { kind: 'area', color: COLORS.green },
    { kind: 'length', color: COLORS.blue },
    { kind: 'segment', color: COLORS.orange },
    { kind: 'count', color: COLORS.red },
  ];

  title(kind: TakeoffKind): string {
    return kindTitle(kind);
  }
  icon(kind: TakeoffKind): string {
    return kindIcon(kind);
  }

  toggleMenu(name: string, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenu.update((current) => (current === name ? null : name));
  }

  setScale(value: number | null): void {
    this.store.scaleDenominator = value;
    this.openMenu.set(null);
  }

  collapseAll(): void {
    this.store.estimateCollapsed = new Set(this.store.estimateGroups.map((g) => g.id));
    this.store.touch();
  }
}
