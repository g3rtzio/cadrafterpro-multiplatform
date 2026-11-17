import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { COLORS, SCALE_GROUPS, TakeoffKind, kindIcon, kindTitle } from '../../models/takeoff';
import { DrawingStore, RibbonTab } from '../../services/drawing.store/drawing.store';
import { MARKUP_TOOLS, MarkupTools } from '../../services/markup-tools/markup-tools';
import { OcrService } from '../../services/ocr/ocr';
import { CostDatabase, TemplateLibrary } from '../../services/template-library/template-library';
import { presetFilters } from '../../models/estimate-filter';
import { Icon } from '../icon/icon';

// Ribbon-style top bar with tabs (Home, Estimating, Templates) — port of RibbonView.swift
@Component({
  selector: 'app-ribbon',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ribbon', '(document:click)': 'openMenu.set(null)' },
  styles: [`
    /* Narrow windows: groups that don't fit are cut at the edge instead of covering the side bar */
    :host { overflow-x: clip; }
    .markup-grid { display: grid; grid-template-columns: repeat(6, 26px); grid-auto-rows: 26px; gap: 2px; flex: 1; align-content: center; }
    .markup-button { display: grid; place-items: center; border: none; background: transparent; padding: 0; border-radius: 5px; }
    .markup-button .icon { font-size: 19px; }
    .markup-button.active { background: var(--accent-soft); }
  `],
  template: `
    @let s = store.watch();
    <!-- Row of tabs -->
    <div class="ribbon-tabs">
      @for (tab of tabs; track tab) {
        <button class="ribbon-tab" [class.active]="s.ribbonTab === tab" (click)="s.showTab(tab)">{{ tab }}</button>
      }
    </div>

    <div class="ribbon-tools">
      <!-- File group (both tabs): Open File, Save (⌘S), Save As (⇧⌘S), Close -->
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <button class="ribbon-button" title="Open File (⌘O)" (click)="openFile.emit()">
            <app-icon class="icon accent" name="folder_open" /><span>Open File</span>
          </button>
          <button class="ribbon-button" title="Save (⌘S)" [disabled]="!s.hasDocument" (click)="s.save()">
            <app-icon class="icon accent" name="save" /><span>Save</span>
          </button>
          <button class="ribbon-button" title="Save As (⇧⌘S)" [disabled]="!s.hasDocument" (click)="s.saveAs()">
            <app-icon class="icon accent" name="save_as" /><span>Save As</span>
          </button>
          <button class="ribbon-button" title="Close File" [disabled]="!s.hasDocument" (click)="s.closeDocument()">
            <app-icon class="icon accent" name="close" /><span>Close</span>
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
                <app-icon class="icon" name="straighten" /><span>Scale</span>
              </button>
              @if (openMenu() === 'scale') {
                <div class="menu scale-menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="setScale(null)">
                    Not Set @if (s.scaleDenominator === null) { <span class="check">✓</span> }
                  </button>
                  @for (group of scaleGroups; track group.title) {
                    <div class="menu-header">{{ group.title }}</div>
                    @for (preset of group.presets; track preset.name) {
                      <button class="menu-item" (click)="setScale(preset.denominator)">
                        {{ preset.name }} @if (s.scaleDenominator === preset.denominator) { <span class="check">✓</span> }
                      </button>
                    }
                  }
                  <div class="menu-divider"></div>
                  <button class="menu-item" (click)="openMenu.set(null); s.requestPageScale()">Custom…</button>
                </div>
              }
            </div>
            <button class="ribbon-button" title="Dimension" [class.active]="s.selectedItem?.name === 'Dimension'"
                    (click)="s.startDimension()">
              <app-icon class="icon" [style.color]="colors.blue" name="straighten" /><span>Dimension</span>
            </button>
            <!-- Snap: measuring clicks jump to the vertices of the drawing -->
            <button class="ribbon-button" title="Snap" [class.active]="s.snapEnabled"
                    (click)="s.snapEnabled = !s.snapEnabled">
              <app-icon class="icon" [style.color]="colors.green" name="my_location" /><span>Snap</span>
            </button>
            <!-- Ortho: straight horizontal / vertical lines (also while Shift is held) -->
            <button class="ribbon-button" title="Ortho: straight horizontal and vertical lines (hold Shift)" [class.active]="s.orthoEnabled"
                    (click)="s.orthoEnabled = !s.orthoEnabled">
              <app-icon class="icon" [style.color]="colors.orange" name="square_foot" /><span>Ortho</span>
            </button>
          </div>
          <div class="ribbon-group-title">Measure</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            @for (t of takeoffs; track t.kind) {
              <!-- Takeoff button: click = continue with the last item of that type,
                   arrow = pick another item or create a new one -->
              <div class="menu-anchor ribbon-split" [class.active]="s.activeKind === t.kind && s.selectedItem?.name !== 'Dimension'">
                <button class="ribbon-button" [title]="title(t.kind)" (click)="s.startTakeoff(t.kind)">
                  <app-icon class="icon" [style.color]="t.color" [name]="icon(t.kind)" /><span>{{ title(t.kind) }}</span>
                </button>
                <button class="ribbon-arrow" (click)="toggleMenu(t.kind, $event)">
                  <app-icon class="icon small" name="expand_more" />
                </button>
                @if (openMenu() === t.kind) {
                  <div class="menu" (click)="$event.stopPropagation()">
                    <button class="menu-item" (click)="openMenu.set(null); s.newTakeoff(t.kind)">New {{ title(t.kind) }}</button>
                    @if (s.takeoffItems(t.kind).length) {
                      <div class="menu-divider"></div>
                      @for (item of s.takeoffItems(t.kind); track item.id) {
                        <button class="menu-item" (click)="openMenu.set(null); s.select(item.id)">
                          <span class="swatch" [style.background]="item.color"></span>{{ item.name }}
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

        <!-- Markup (like Revu): text box, callout, cloud, shapes, lines, pen and highlight -->
        <div class="ribbon-group">
          <div class="markup-grid">
            @for (t of markupTools; track t.kind) {
              <button class="markup-button" [class.active]="markups.tool() === t.kind" [disabled]="!s.hasDocument"
                      [title]="t.title + ' — ' + t.hint" (click)="markups.start(t.kind)">
                <app-icon class="icon" [name]="t.icon" />
              </button>
            }
          </div>
          <div class="ribbon-group-title">Markup</div>
        </div>

        <!-- Snapshot (copy a region, paste it on any page) and Overlay (compare two pages) -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="Snapshot: drag a box to copy that region"
                    [disabled]="!s.hasDocument" [class.active]="s.snapshotMode === 'capture'"
                    (click)="s.snapshotMode === 'capture' ? s.cancelSnapshot() : s.startSnapshot()">
              <app-icon class="icon" [style.color]="colors.purple" name="screenshot_region" /><span>Snapshot</span>
            </button>
            <button class="ribbon-button" title="Paste the snapshot (Ctrl+V)"
                    [disabled]="!s.hasDocument || !s.snapshotClip" [class.active]="s.snapshotMode === 'place'"
                    (click)="s.snapshotMode === 'place' ? s.cancelSnapshot() : s.pasteSnapshot()">
              <app-icon class="icon" [style.color]="colors.purple" name="content_paste" /><span>Paste</span>
            </button>
            <button class="ribbon-button" title="Overlay: show another page on top in a different color"
                    [disabled]="!s.hasDocument || s.pageCount < 2" [class.active]="!!store.overlay()"
                    (click)="store.overlay() ? s.closeOverlay() : s.startOverlay()">
              <app-icon class="icon" [style.color]="colors.orange" name="layers" /><span>Overlay</span>
            </button>
          </div>
          <div class="ribbon-group-title">Compare</div>
        </div>
        <!-- OCR: click = recognize the text inside a box; arrow = whole page, all pages, panel -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <div class="menu-anchor ribbon-split" [class.active]="ocr.drawingRegion() || ocr.busy()">
              <button class="ribbon-button" title="OCR: drag a box around text to recognize it"
                      [disabled]="!s.hasDocument" (click)="ocr.startRegion()">
                <app-icon class="icon" [style.color]="colors.purple" name="document_scanner" /><span>OCR</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('ocr', $event)">
                <app-icon class="icon small" name="expand_more" />
              </button>
              @if (openMenu() === 'ocr') {
                <div class="menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" [disabled]="ocr.busy()" (click)="openMenu.set(null); ocr.startRegion()">OCR Region</button>
                  <button class="menu-item" [disabled]="ocr.busy()" (click)="openMenu.set(null); ocr.recognizeCurrentPage()">OCR Current Page</button>
                  <button class="menu-item" [disabled]="ocr.busy()" (click)="openMenu.set(null); ocr.recognizeAllPages()">OCR All Pages</button>
                  <div class="menu-divider"></div>
                  <button class="menu-item" (click)="openMenu.set(null); ocr.panelOpen.set(true)">Show OCR Panel</button>
                </div>
              }
            </div>
          </div>
          <div class="ribbon-group-title">Text</div>
        </div>
      } @else if (s.ribbonTab === 'Estimating') {
        <!-- Estimating tab: groups, export, parts, properties and columns -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="New Group" [disabled]="!s.hasDocument" (click)="s.newEstimateGroup()">
              <app-icon class="icon accent" name="create_new_folder" /><span>New Group</span>
            </button>
            <button class="ribbon-button" (click)="s.estimateCollapsed.clear(); s.touch()">
              <app-icon class="icon" name="unfold_more" /><span>Expand All</span>
            </button>
            <button class="ribbon-button" (click)="collapseAll()">
              <app-icon class="icon" name="unfold_less" /><span>Collapse All</span>
            </button>
            <button class="ribbon-button" title="Export to Excel (.xlsx)" [disabled]="!s.hasDocument" (click)="s.exportExcel()">
              <app-icon class="icon" [style.color]="colors.green" name="table_view" /><span>Export to Excel</span>
            </button>
          </div>
          <div class="ribbon-group-title">Estimate</div>
        </div>

        <!-- Parts: estimate lines without a measurement; "As Sub-Item" hangs it under the selected row -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="New Part" [disabled]="!s.hasDocument" (click)="s.newPart(false)">
                <app-icon class="icon" [style.color]="colors.orange" name="add_box" /><span>New Part</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('part', $event)">
                <app-icon class="icon small" name="expand_more" />
              </button>
              @if (openMenu() === 'part') {
                <div class="menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="openMenu.set(null); s.newPart(false)">New Part</button>
                  <button class="menu-item" [disabled]="!s.canAddSubItem" (click)="openMenu.set(null); s.newPart(true)">
                    As Sub-Item
                  </button>
                  @if (costParts().length) {
                    <div class="menu-divider"></div>
                    <div class="menu-header">Cost Database (under the selected row)</div>
                    @for (t of costParts(); track t.id) {
                      <button class="menu-item" [disabled]="!s.canAddSubItem" (click)="openMenu.set(null); costDatabase.addPartToDocument(t)">
                        <app-icon class="icon small" style="color: #ff9500" name="database" />{{ t.name }}
                      </button>
                    }
                  }
                  @if (partTemplates().length) {
                    <div class="menu-divider"></div>
                    <div class="menu-header">Part Templates (under the selected row)</div>
                    @for (t of partTemplates(); track t.id) {
                      <button class="menu-item" [disabled]="!s.canAddSubItem" (click)="openMenu.set(null); library.addPartToDocument(t)">
                        <app-icon class="icon small" style="color: #ff9500" name="widgets" />{{ t.name }}
                      </button>
                    }
                  }
                </div>
              }
            </div>
            <button class="ribbon-button" title="Properties of the selected row"
                    [disabled]="!s.canAddSubItem" (click)="s.openProperties()">
              <app-icon class="icon" name="tune" /><span>Properties</span>
            </button>
            <button class="ribbon-button" title="Delete the selected part or group"
                    [disabled]="!s.selectedEstimateKey" (click)="s.deleteEstimateSelection()">
              <app-icon class="icon" [style.color]="colors.red" name="delete" /><span>Delete</span>
            </button>
            <button class="ribbon-button" title="Columns of the estimate" [disabled]="!s.hasDocument" (click)="s.openColumns()">
              <app-icon class="icon" name="view_column" /><span>Columns</span>
            </button>
            <!-- Filter: the Filter Builder, or a saved / ready-made filter from the menu -->
            <div class="menu-anchor ribbon-split" [class.active]="s.filterActive">
              <button class="ribbon-button" title="Filter Builder: show only the rows that pass conditions"
                      [disabled]="!s.hasDocument" (click)="s.openFilter()">
                <app-icon class="icon accent" name="filter_alt" /><span>Filter</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('filter', $event)">
                <app-icon class="icon small" name="expand_more" />
              </button>
              @if (openMenu() === 'filter') {
                <div class="menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="openMenu.set(null); s.openFilter()">
                    <app-icon class="icon small" name="add" />New / Edit Filter…
                  </button>
                  @if (s.filterActive) {
                    <button class="menu-item" (click)="openMenu.set(null); s.setEstimateFilter(null)">
                      <app-icon class="icon small" name="filter_alt_off" />Clear Filter
                    </button>
                  }
                  <div class="menu-divider"></div>
                  <div class="menu-header">Saved Filters</div>
                  @for (f of s.savedFilters; track f.id) {
                    <button class="menu-item" (click)="openMenu.set(null); s.useNamedFilter(f)">
                      <app-icon class="icon small" [name]="s.estimateFilterName === f.name ? 'check' : 'filter_alt'" />{{ f.name }}
                    </button>
                  } @empty {
                    <div class="menu-header">None yet</div>
                  }
                  <div class="menu-divider"></div>
                  <div class="menu-header">Ready-made</div>
                  @for (f of presets; track f.id) {
                    <button class="menu-item" (click)="openMenu.set(null); s.useNamedFilter(f)">
                      <app-icon class="icon small" [name]="s.estimateFilterName === f.name ? 'check' : 'bolt'" />{{ f.name }}
                    </button>
                  }
                </div>
              }
            </div>
            @if (s.filterActive) {
              <button class="ribbon-button" title="Show every row again" (click)="s.setEstimateFilter(null)">
                <app-icon class="icon" name="filter_alt_off" /><span>Clear Filter</span>
              </button>
            }
          </div>
          <div class="ribbon-group-title">Items</div>
        </div>
      } @else if (s.ribbonTab === 'Templates') {
        <!-- Templates tab: the template library (see templates-view) -->
        @let lib = library.watch();
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="New Folder" (click)="lib.newFolder()">
              <app-icon class="icon" [style.color]="colors.yellow" name="create_new_folder" /><span>New Folder</span>
            </button>
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="New Template" (click)="toggleMenu('newTemplate', $event)">
                <app-icon class="icon accent" name="note_add" /><span>New Template</span>
              </button>
              <button class="ribbon-arrow" (click)="toggleMenu('newTemplate', $event)">
                <app-icon class="icon small" name="expand_more" />
              </button>
              @if (openMenu() === 'newTemplate') {
                <div class="menu" (click)="$event.stopPropagation()">
                  @for (t of takeoffs; track t.kind) {
                    <button class="menu-item" (click)="openMenu.set(null); lib.newTemplate(t.kind)">
                      <app-icon class="icon small" [style.color]="t.color" [name]="icon(t.kind)" />{{ title(t.kind) }}
                    </button>
                  }
                  <div class="menu-divider"></div>
                  <button class="menu-item" title="A part to add under any item of the estimate" (click)="openMenu.set(null); lib.newPartTemplate()">
                    <app-icon class="icon small" style="color: #ff9500" name="widgets" />Part
                  </button>
                </div>
              }
            </div>
            <!-- Add from Document: an element of the open drawing, with its properties and parts -->
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="Save an element of this drawing as a template"
                      [disabled]="!s.hasDocument" (click)="toggleMenu('fromDocument', $event)">
                <app-icon class="icon" [style.color]="colors.purple" name="input" /><span>Add from Document</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('fromDocument', $event)">
                <app-icon class="icon small" name="expand_more" />
              </button>
              @if (openMenu() === 'fromDocument') {
                <div class="menu" (click)="$event.stopPropagation()">
                  @for (el of lib.documentElements(); track el.name) {
                    <button class="menu-item" (click)="openMenu.set(null); lib.addFromDocument(el.name)">
                      <span class="swatch" [style.background]="el.color"></span>{{ el.name }}
                    </button>
                  } @empty {
                    <div class="menu-header">Nothing measured yet</div>
                  }
                </div>
              }
            </div>
          </div>
          <div class="ribbon-group-title">Library</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button"
                    [title]="lib.selectedTemplate?.isPart ? 'Add the selected part template under the item selected in the estimate' : 'Measure with the selected template on the plan'"
                    [disabled]="!s.hasDocument || !lib.selectedTemplate" (click)="lib.useTemplate()">
              <app-icon class="icon" [style.color]="colors.green" name="play_circle" /><span>Use Template</span>
            </button>
            <button class="ribbon-button" title="New Part under the selected template or part"
                    [disabled]="!lib.selectedTemplate" (click)="lib.newPart()">
              <app-icon class="icon" [style.color]="colors.orange" name="add_box" /><span>New Part</span>
            </button>
            <button class="ribbon-button" title="Duplicate the selected template"
                    [disabled]="!lib.selectedTemplate || lib.selection?.type !== 'template'" (click)="lib.duplicate()">
              <app-icon class="icon" name="content_copy" /><span>Duplicate</span>
            </button>
            <button class="ribbon-button" title="Delete the selected folder, template or part"
                    [disabled]="!lib.selection" (click)="lib.deleteSelection()">
              <app-icon class="icon" [style.color]="colors.red" name="delete" /><span>Delete</span>
            </button>
          </div>
          <div class="ribbon-group-title">Templates</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="Add templates from a .json file" (click)="lib.importLibrary()">
              <app-icon class="icon accent" name="upload_file" /><span>Import</span>
            </button>
            <button class="ribbon-button" title="Save the whole library as a .json file" (click)="lib.exportLibrary()">
              <app-icon class="icon accent" name="download" /><span>Export</span>
            </button>
          </div>
          <div class="ribbon-group-title">Share</div>
        </div>
      } @else {
        <!-- Cost Database tab: a library of priced parts only (see templates-view with [database]) -->
        @let db = costDatabase.watch();
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="New Folder" (click)="db.newFolder()">
              <app-icon class="icon" [style.color]="colors.yellow" name="create_new_folder" /><span>New Folder</span>
            </button>
            <button class="ribbon-button" title="New part in the Cost Database" (click)="db.newPartTemplate()">
              <app-icon class="icon" [style.color]="colors.orange" name="add_box" /><span>New Part</span>
            </button>
            <button class="ribbon-button" title="New part under the selected part (added together with it)"
                    [disabled]="!db.selectedTemplate" (click)="db.newPart()">
              <app-icon class="icon" [style.color]="colors.orange" name="subdirectory_arrow_right" /><span>Sub-Part</span>
            </button>
          </div>
          <div class="ribbon-group-title">Library</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="Add the selected part under the item selected in the estimate"
                    [disabled]="!s.hasDocument || !db.selectedTemplate" (click)="db.useTemplate()">
              <app-icon class="icon" [style.color]="colors.green" name="play_circle" /><span>Add to Item</span>
            </button>
            <button class="ribbon-button" title="Duplicate the selected part"
                    [disabled]="!db.selectedTemplate || db.selection?.type !== 'template'" (click)="db.duplicate()">
              <app-icon class="icon" name="content_copy" /><span>Duplicate</span>
            </button>
            <button class="ribbon-button" title="Delete the selected folder or part"
                    [disabled]="!db.selection" (click)="db.deleteSelection()">
              <app-icon class="icon" [style.color]="colors.red" name="delete" /><span>Delete</span>
            </button>
          </div>
          <div class="ribbon-group-title">Parts</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" [disabled]="!s.hasDocument" (click)="db.updateDocumentPrices()"
                    title="Copy the prices of the Cost Database to every part of this document with the same name">
              <app-icon class="icon" [style.color]="colors.green" name="price_change" /><span>Update Prices</span>
            </button>
          </div>
          <div class="ribbon-group-title">Document</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="Add parts from a .json file" (click)="db.importLibrary()">
              <app-icon class="icon accent" name="upload_file" /><span>Import</span>
            </button>
            <button class="ribbon-button" title="Save the whole Cost Database as a .json file" (click)="db.exportLibrary()">
              <app-icon class="icon accent" name="download" /><span>Export</span>
            </button>
          </div>
          <div class="ribbon-group-title">Share</div>
        </div>
      }
    </div>
  `,
})
export class Ribbon {
  readonly store = inject(DrawingStore);
  readonly markups = inject(MarkupTools);
  readonly markupTools = MARKUP_TOOLS;
  readonly ocr = inject(OcrService);
  readonly library = inject(TemplateLibrary);
  readonly costDatabase = inject(CostDatabase);
  readonly presets = presetFilters();

  // Part templates of the library, offered in the Estimating New Part menu
  partTemplates() { return this.library.watch().data.templates.filter(t => t.isPart); }
  costParts() { return this.costDatabase.watch().data.templates.filter(t => t.isPart).sort((a, b) => a.name.localeCompare(b.name)); }
  readonly openFile = output<void>();
  readonly openMenu = signal<string | null>(null);
  readonly tabs: RibbonTab[] = ['Home', 'Estimating', 'Templates', 'Cost Database'];
  readonly scaleGroups = SCALE_GROUPS;
  readonly colors = COLORS;
  readonly takeoffs: { kind: TakeoffKind; color: string }[] = [
    { kind: 'area', color: COLORS.green },
    { kind: 'length', color: COLORS.blue },
    { kind: 'segment', color: COLORS.orange },
    { kind: 'count', color: COLORS.red },
  ];

  title(kind: TakeoffKind): string { return kindTitle(kind); }
  icon(kind: TakeoffKind): string { return kindIcon(kind); }

  toggleMenu(name: string, event: MouseEvent): void {
    event.stopPropagation();
    this.openMenu.update(current => current === name ? null : name);
  }

  setScale(value: number | null): void {
    this.store.scaleDenominator = value;
    this.openMenu.set(null);
  }

  collapseAll(): void {
    this.store.estimateCollapsed = new Set(this.store.estimateGroups.map(g => g.id));
    this.store.touch();
  }
}
