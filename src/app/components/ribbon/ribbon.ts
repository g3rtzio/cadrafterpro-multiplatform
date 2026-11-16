import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { COLORS, SCALE_GROUPS, TakeoffKind, kindIcon, kindTitle } from '../../models/takeoff';
import { DrawingStore, RibbonTab } from '../../services/drawing.store';
import { MARKUP_TOOLS, MarkupTools } from '../../services/markup-tools';
import { OcrService } from '../../services/ocr';
import { TemplateLibrary } from '../../services/template-library';

// Ribbon-style top bar with tabs (Home, Estimating, Templates) — port of RibbonView.swift
@Component({
  selector: 'app-ribbon',
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
            <span class="icon accent">folder_open</span><span>Open File</span>
          </button>
          <button class="ribbon-button" title="Save (⌘S)" [disabled]="!s.hasDocument" (click)="s.save()">
            <span class="icon accent">save</span><span>Save</span>
          </button>
          <button class="ribbon-button" title="Save As (⇧⌘S)" [disabled]="!s.hasDocument" (click)="s.saveAs()">
            <span class="icon accent">save_as</span><span>Save As</span>
          </button>
          <button class="ribbon-button" title="Close File" [disabled]="!s.hasDocument" (click)="s.closeDocument()">
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
              <span class="icon" [style.color]="colors.blue">straighten</span><span>Dimension</span>
            </button>
            <!-- Snap: measuring clicks jump to the vertices of the drawing -->
            <button class="ribbon-button" title="Snap" [class.active]="s.snapEnabled"
                    (click)="s.snapEnabled = !s.snapEnabled">
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
              <div class="menu-anchor ribbon-split" [class.active]="s.activeKind === t.kind && s.selectedItem?.name !== 'Dimension'">
                <button class="ribbon-button" [title]="title(t.kind)" (click)="s.startTakeoff(t.kind)">
                  <span class="icon" [style.color]="t.color">{{ icon(t.kind) }}</span><span>{{ title(t.kind) }}</span>
                </button>
                <button class="ribbon-arrow" (click)="toggleMenu(t.kind, $event)">
                  <span class="icon small">expand_more</span>
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
                <span class="icon">{{ t.icon }}</span>
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
              <span class="icon" [style.color]="colors.purple">screenshot_region</span><span>Snapshot</span>
            </button>
            <button class="ribbon-button" title="Paste the snapshot (Ctrl+V)"
                    [disabled]="!s.hasDocument || !s.snapshotClip" [class.active]="s.snapshotMode === 'place'"
                    (click)="s.snapshotMode === 'place' ? s.cancelSnapshot() : s.pasteSnapshot()">
              <span class="icon" [style.color]="colors.purple">content_paste</span><span>Paste</span>
            </button>
            <button class="ribbon-button" title="Overlay: show another page on top in a different color"
                    [disabled]="!s.hasDocument || s.pageCount < 2" [class.active]="!!store.overlay()"
                    (click)="store.overlay() ? s.closeOverlay() : s.startOverlay()">
              <span class="icon" [style.color]="colors.orange">layers</span><span>Overlay</span>
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
                <span class="icon" [style.color]="colors.purple">document_scanner</span><span>OCR</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('ocr', $event)">
                <span class="icon small">expand_more</span>
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
              <span class="icon accent">create_new_folder</span><span>New Group</span>
            </button>
            <button class="ribbon-button" (click)="s.estimateCollapsed.clear(); s.touch()">
              <span class="icon">unfold_more</span><span>Expand All</span>
            </button>
            <button class="ribbon-button" (click)="collapseAll()">
              <span class="icon">unfold_less</span><span>Collapse All</span>
            </button>
            <button class="ribbon-button" title="Export to Excel (.xlsx)" [disabled]="!s.hasDocument" (click)="s.exportExcel()">
              <span class="icon" [style.color]="colors.green">table_view</span><span>Export to Excel</span>
            </button>
          </div>
          <div class="ribbon-group-title">Estimate</div>
        </div>

        <!-- Parts: estimate lines without a measurement; "As Sub-Item" hangs it under the selected row -->
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="New Part" [disabled]="!s.hasDocument" (click)="s.newPart(false)">
                <span class="icon" [style.color]="colors.orange">add_box</span><span>New Part</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('part', $event)">
                <span class="icon small">expand_more</span>
              </button>
              @if (openMenu() === 'part') {
                <div class="menu" (click)="$event.stopPropagation()">
                  <button class="menu-item" (click)="openMenu.set(null); s.newPart(false)">New Part</button>
                  <button class="menu-item" [disabled]="!s.canAddSubItem" (click)="openMenu.set(null); s.newPart(true)">
                    As Sub-Item
                  </button>
                </div>
              }
            </div>
            <button class="ribbon-button" title="Properties of the selected row"
                    [disabled]="!s.canAddSubItem" (click)="s.openProperties()">
              <span class="icon">tune</span><span>Properties</span>
            </button>
            <button class="ribbon-button" title="Delete the selected part or group"
                    [disabled]="!s.selectedEstimateKey" (click)="s.deleteEstimateSelection()">
              <span class="icon" [style.color]="colors.red">delete</span><span>Delete</span>
            </button>
            <button class="ribbon-button" title="Columns of the estimate" [disabled]="!s.hasDocument" (click)="s.openColumns()">
              <span class="icon">view_column</span><span>Columns</span>
            </button>
          </div>
          <div class="ribbon-group-title">Items</div>
        </div>
      } @else {
        <!-- Templates tab: the template library (see templates-view) -->
        @let lib = library.watch();
        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="New Folder" (click)="lib.newFolder()">
              <span class="icon" [style.color]="colors.yellow">create_new_folder</span><span>New Folder</span>
            </button>
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="New Template" (click)="toggleMenu('newTemplate', $event)">
                <span class="icon accent">note_add</span><span>New Template</span>
              </button>
              <button class="ribbon-arrow" (click)="toggleMenu('newTemplate', $event)">
                <span class="icon small">expand_more</span>
              </button>
              @if (openMenu() === 'newTemplate') {
                <div class="menu" (click)="$event.stopPropagation()">
                  @for (t of takeoffs; track t.kind) {
                    <button class="menu-item" (click)="openMenu.set(null); lib.newTemplate(t.kind)">
                      <span class="icon small" [style.color]="t.color">{{ icon(t.kind) }}</span>{{ title(t.kind) }}
                    </button>
                  }
                </div>
              }
            </div>
            <!-- Add from Document: an element of the open drawing, with its properties and parts -->
            <div class="menu-anchor ribbon-split">
              <button class="ribbon-button" title="Save an element of this drawing as a template"
                      [disabled]="!s.hasDocument" (click)="toggleMenu('fromDocument', $event)">
                <span class="icon" [style.color]="colors.purple">input</span><span>Add from Document</span>
              </button>
              <button class="ribbon-arrow" [disabled]="!s.hasDocument" (click)="toggleMenu('fromDocument', $event)">
                <span class="icon small">expand_more</span>
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
            <button class="ribbon-button" title="Measure with the selected template on the plan"
                    [disabled]="!s.hasDocument || !lib.selectedTemplate" (click)="lib.useTemplate()">
              <span class="icon" [style.color]="colors.green">play_circle</span><span>Use Template</span>
            </button>
            <button class="ribbon-button" title="New Part under the selected template or part"
                    [disabled]="!lib.selectedTemplate" (click)="lib.newPart()">
              <span class="icon" [style.color]="colors.orange">add_box</span><span>New Part</span>
            </button>
            <button class="ribbon-button" title="Duplicate the selected template"
                    [disabled]="!lib.selectedTemplate || lib.selection?.type !== 'template'" (click)="lib.duplicate()">
              <span class="icon">content_copy</span><span>Duplicate</span>
            </button>
            <button class="ribbon-button" title="Delete the selected folder, template or part"
                    [disabled]="!lib.selection" (click)="lib.deleteSelection()">
              <span class="icon" [style.color]="colors.red">delete</span><span>Delete</span>
            </button>
          </div>
          <div class="ribbon-group-title">Templates</div>
        </div>

        <div class="ribbon-group">
          <div class="ribbon-buttons">
            <button class="ribbon-button" title="Add templates from a .json file" (click)="lib.importLibrary()">
              <span class="icon accent">upload_file</span><span>Import</span>
            </button>
            <button class="ribbon-button" title="Save the whole library as a .json file" (click)="lib.exportLibrary()">
              <span class="icon accent">download</span><span>Export</span>
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
  readonly openFile = output<void>();
  readonly openMenu = signal<string | null>(null);
  readonly tabs: RibbonTab[] = ['Home', 'Estimating', 'Templates'];
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
