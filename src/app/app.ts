import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { EstimateView } from './components/estimate-view/estimate-view';
import { LayoutsPanel } from './components/layouts-panel/layouts-panel';
import { TemplatesView } from './components/templates-view/templates-view';
import { FilterBuilder } from './components/filter-builder/filter-builder';
import { PlanView } from './components/plan-view/plan-view';
import { SidePanel } from './components/side-panel/side-panel';
import { Ribbon } from './components/ribbon/ribbon';
import { ColumnsDialog } from './components/columns-dialog/columns-dialog';
import { PropertiesDialog } from './components/properties-dialog/properties-dialog';
import { ScaleDialog } from './components/scale-dialog/scale-dialog';
import { StatusBar } from './components/status-bar/status-bar';
import { TakeoffTree } from './components/takeoff-tree/takeoff-tree';
import { Thumbnails } from './components/thumbnails/thumbnails';
import { DrawingStore } from './services/drawing.store/drawing.store';
import { OcrPanel } from './components/ocr-panel/ocr-panel';
import { OcrService } from './services/ocr/ocr';
import { Icon } from './components/icon/icon';
import { Resizable } from './components/resizable/resizable';
import { SlipSheetDialog } from './components/slip-sheet-dialog/slip-sheet-dialog';
import { SlipSheet } from './services/slip-sheet/slip-sheet';
import { PageLabeler } from './services/page-labels/page-labels';
import { InsertPagesDialog } from './components/insert-pages-dialog/insert-pages-dialog';
import { PageLabelsDialog } from './components/page-labels-dialog/page-labels-dialog';
import { RotatePagesDialog } from './components/rotate-pages-dialog/rotate-pages-dialog';
import { ExtractPagesDialog } from './components/extract-pages-dialog/extract-pages-dialog';
import { PitchDialog } from './components/pitch-dialog/pitch-dialog';

// Main window — port of ContentView.swift:
// left the element tree or the page thumbnails, ribbon on top, the plan (one or two panes)
// in the middle, the status bar at the bottom and the properties panel on the right
const SPLIT_KEY = 'cadrafterpro.splitRatio';

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 0.15 && v <= 0.85 ? v : 0.5;
  } catch {
    return 0.5;
  }
}

@Component({
  selector: 'app-root',
  imports: [Icon, Resizable, SlipSheetDialog, InsertPagesDialog, PageLabelsDialog, RotatePagesDialog, ExtractPagesDialog, PitchDialog, OcrPanel, ColumnsDialog, FilterBuilder, EstimateView, LayoutsPanel, PlanView, PropertiesDialog, SidePanel, Ribbon, ScaleDialog, StatusBar, TakeoffTree, TemplatesView, Thumbnails],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'app',
    '(document:keydown)': 'onKey($event)',
    '(dragover)': '$event.preventDefault()',
    '(drop)': 'onDrop($event)',
  },
  template: `
    @let s = store.watch();
    <!-- Left: page thumbnails or the element tree; in the Estimating tab, the Estimating Layouts panel -->
    @if (showSidebar() && s.ribbonTab === 'Estimating') {
      <aside class="sidebar layouts-sidebar"><app-layouts-panel /></aside>
    } @else if (showSidebar()) {
      <aside class="sidebar" appResizable="right" resizeKey="sidebar" [minWidth]="200" [maxWidth]="600">
        <div class="segmented sidebar-picker">
          <button [class.active]="sidebarMode() === 'elements'" (click)="sidebarMode.set('elements')">Elements</button>
          <button [class.active]="sidebarMode() === 'pages'" (click)="sidebarMode.set('pages')">Pages</button>
        </div>
        <div class="side-search sidebar-search">
          <app-icon class="icon small secondary" name="search" />
          <input type="text" [placeholder]="sidebarMode() === 'elements' ? 'Find page or element' : 'Find page'"
                 [value]="sidebarFilter()" (input)="sidebarFilter.set($any($event.target).value)"
                 (keydown.escape)="sidebarFilter.set('')" />
          @if (sidebarFilter()) {
            <button class="icon-button" title="Clear" (click)="sidebarFilter.set('')"><app-icon class="icon small" name="close" /></button>
          }
        </div>
        @if (sidebarMode() === 'elements') { <app-takeoff-tree [filter]="sidebarFilter()" /> }
        @else { <app-thumbnails [filter]="sidebarFilter()" /> }
      </aside>
    }

    <main class="main">
      <!-- Title bar: file name, pages, zoom and panels -->
      <header class="titlebar">
        <button class="icon-button" title="Sidebar" (click)="showSidebar.set(!showSidebar())"><app-icon class="icon" name="left_panel_open" /></button>
        @if (s.tabs.length) {
          <!-- One tab per open document -->
          <div class="doc-tabs" role="tablist">
            @for (t of s.tabs; track t.id) {
              <div class="doc-tab" role="tab" [class.active]="t.active" [attr.aria-selected]="t.active" [title]="t.name"
                   (click)="s.switchTab(t.id)" (auxclick)="$event.button === 1 && s.closeTab(t.id)">
                <span class="doc-tab-name">{{ t.name }}</span>
                @if (t.edited) { <span class="doc-tab-dot" title="Edited"></span> }
                <button class="doc-tab-close" title="Close" (click)="$event.stopPropagation(); s.closeTab(t.id)">
                  <app-icon class="icon small" name="close" />
                </button>
              </div>
            }
            <button class="icon-button doc-tab-add" title="Open File…" (click)="openFile()"><app-icon class="icon small" name="add" /></button>
          </div>
        } @else {
          <span class="title">CadrafterPro</span>
          <span class="spacer"></span>
        }
        <button class="icon-button" title="Previous Page" (click)="s.previousPage()"><app-icon class="icon" name="chevron_left" /></button>
        <button class="icon-button" title="Next Page" (click)="s.nextPage()"><app-icon class="icon" name="chevron_right" /></button>
        <button class="icon-button" title="Zoom Out" (click)="s.zoomOut()"><app-icon class="icon" name="zoom_out" /></button>
        <button class="icon-button" title="Fit" (click)="s.fitPage()"><app-icon class="icon" name="fit_screen" /></button>
        <button class="icon-button" title="Zoom In" (click)="s.zoomIn()"><app-icon class="icon" name="zoom_in" /></button>
        <button class="icon-button" title="Properties" (click)="showInspector.set(!showInspector())"><app-icon class="icon" name="right_panel_open" /></button>
      </header>

      <!-- Top: toolbar with tabs (Home / Estimating / Templates) -->
      <app-ribbon (openFile)="openFile()" />

      <!-- Center: the plan (one or two panes), or on top of it the estimate or the templates -->
      <div class="center">
        <div class="plan-area" #planArea [class.vertical]="s.splitMode === 'vertical'" [class.horizontal]="s.splitMode === 'horizontal'">
          @for (pane of panes(); track pane) {
            <!-- Bar between the two views: drag to give one more room, double click = half and half -->
            @if (pane === 1) {
              <div class="pane-splitter" title="Drag to resize the views (double click: half and half)"
                   (mousedown)="startSplit($event, planArea)" (dblclick)="setSplit(0.5)"></div>
            }
            <div class="pane" [class.active-pane]="s.splitMode !== 'single' && s.activePane === pane"
                 [style.flex]="s.splitMode !== 'single' && pane === 0 ? '0 0 ' + splitRatio() * 100 + '%' : null">
              @if (s.splitMode !== 'single') {
                <div class="pane-bar" (mousedown)="s.activate(pane)">
                  @let paneDoc = s.docView(pane);
                  @if (s.tabs.length > 1) {
                    <!-- Document shown in this view -->
                    <select class="pane-doc" title="Document in this view" (mousedown)="$event.stopPropagation()"
                            (change)="s.setPaneDoc(pane, $any($event.target).value)">
                      @for (t of s.tabs; track t.id) {
                        <option [value]="t.id" [selected]="t.id === s.paneDocId(pane)">{{ t.name }}</option>
                      }
                    </select>
                  }
                  <span class="secondary small">{{ paneDoc.pageName(paneDoc.pageIndexes[pane]) }}</span>
                  <span class="spacer"></span>
                  <button class="icon-button" title="Close This View" (click)="s.closePane(pane)"><app-icon class="icon small" name="close" /></button>
                </div>
              }
              <app-plan-view [pane]="pane" />
            </div>
          }
        </div>
        @if (s.ribbonTab === 'Estimating') { <app-estimate-view /> }
        @if (s.ribbonTab === 'Templates') { <app-templates-view /> }
        @if (s.ribbonTab === 'Cost Database') { <app-templates-view [database]="true" /> }
        <!-- OCR panel (text recognition) over the plan -->
        @if (ocr.panelOpen()) { <app-ocr-panel /> }

        <!-- Short message after saving or exporting -->
        @if (s.toastMessage) {
          <div class="toast" [class.error]="s.toastIsError">
            <app-icon class="icon small" [name]="s.toastIsError ? 'warning' : 'check_circle'" />{{ s.toastMessage }}
          </div>
        }
      </div>

      <!-- Bottom: Revu-style status bar -->
      <app-status-bar />
    </main>

    <!-- Right: Revu-style side bar (Settings, Search, Scale) -->
    <app-side-panel [(open)]="showInspector" />

    <!-- Scale dialog (page scale, viewport, or asked before measuring); a new one for every request -->
    @for (request of s.scaleRequest ? [s.scaleRequest] : []; track request.id) {
      <app-scale-dialog />
    }

    <!-- Estimate: Properties of a row (a new window for every row) and the Columns window -->
    @for (key of s.propertiesKey ? [s.propertiesKey] : []; track key) {
      <app-properties-dialog [rowKey]="key" />
    }
    @if (s.filterOpen) {
      <app-filter-builder />
    }
    @if (slipSheet.request()) {
      <app-slip-sheet-dialog />
    }
    <!-- Page windows (open from the Page tab or the Pages panel) -->
    @if (labeler.dialogOpen() && !labeler.selecting()) { <app-page-labels-dialog /> }
    @for (request of s.insertRequest ? [s.insertRequest] : []; track request.id) {
      <app-insert-pages-dialog />
    }
    @if (s.batchRotateOpen) { <app-rotate-pages-dialog /> }
    @if (s.extractOpen) { <app-extract-pages-dialog /> }
    @if (s.pitchOpen) { <app-pitch-dialog /> }
    @if (s.columnsOpen) {
      <app-columns-dialog />
    }
  `,
})
export class App {
  readonly store = inject(DrawingStore);
  readonly ocr = inject(OcrService);
  readonly slipSheet = inject(SlipSheet);
  readonly labeler = inject(PageLabeler);
  readonly showSidebar = signal(true);
  readonly showInspector = signal(true);
  readonly sidebarMode = signal<'elements' | 'pages'>('elements');
  readonly sidebarFilter = signal('');               // search box above the Elements / Pages list

  constructor() {
  }

  // Share of the first view when the plan is split (remembered on this computer)
  readonly splitRatio = signal(readSplit());

  setSplit(ratio: number): void {
    const r = Math.min(0.85, Math.max(0.15, ratio));
    this.splitRatio.set(r);
    try { localStorage.setItem(SPLIT_KEY, String(r)); } catch { /* storage blocked */ }
  }

  startSplit(e: MouseEvent, area: HTMLElement): void {
    e.preventDefault();
    const vertical = this.store.splitMode === 'vertical';
    const move = (ev: MouseEvent) => {
      const r = area.getBoundingClientRect();
      this.setSplit(vertical ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-split');
    };
    document.body.classList.add('resizing-split');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  panes(): number[] {
    return this.store.watch().splitMode === 'single' ? [0] : [0, 1];
  }

  // Open File: with the File System Access API (Chrome, Edge) Save can write over the same file;
  // other browsers use a normal file picker and Save downloads a copy
  async openFile(): Promise<void> {
    const picker = (window as unknown as { showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]> })
      .showOpenFilePicker;
    if (!picker) {
      this.pickWithInput();
      return;
    }
    try {
      // Several files can be picked: each one opens in its own tab
      const handles = await picker({ multiple: true, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      for (const handle of handles) {
        const file = await handle.getFile();
        await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name, handle);
      }
    } catch {
      // cancelled
    }
  }

  // Safari and Firefox: a hidden file input made on the fly
  private pickWithInput(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of [...(input.files ?? [])]) await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name, null);
    });
    input.click();
  }

  // Drop a PDF on the window. The file and its handle are read before any await:
  // the dropped items stop working as soon as the event ends.
  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    // Every dropped PDF opens in its own tab
    const dropped = [...(event.dataTransfer?.items ?? [])].filter(i => i.kind === 'file').map(item => {
      const withHandle = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
      return { file: item.getAsFile(), handle: withHandle.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null) };
    });
    for (const { file, handle: pendingHandle } of dropped) {
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) continue;
      const handle = await pendingHandle;
      await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name,
        handle && handle.kind === 'file' ? handle as FileSystemFileHandle : null);
    }
  }

  // ⌘O opens a drawing, ⌘S saves, ⇧⌘S saves a copy, ⌘Z undoes, ⇧⌘Z / Ctrl+Y redoes
  onKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    // Ctrl+Tab / Ctrl+Shift+Tab: next / previous document; Ctrl+W closes it (in the desktop app)
    if (key === 'tab' && e.ctrlKey) {
      e.preventDefault();
      this.store.nextTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (key === 'w' && this.store.hasDocument) {
      e.preventDefault();
      this.store.closeDocument();
      return;
    }
    // While typing in a text field, Undo belongs to the field
    const target = e.target as HTMLElement | null;
    const textInput = target instanceof HTMLInputElement && /^(text|search|number|email|url|tel|password)$/.test(target.type);
    const typing = textInput || target instanceof HTMLTextAreaElement || !!target?.isContentEditable;
    if ((key === 'z' || key === 'y') && !typing) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) this.store.redo(); else this.store.undo();
      return;
    }
    if (key === 'o') {
      e.preventDefault();
      this.openFile();
    } else if (key === 's') {
      e.preventDefault();
      if (e.shiftKey) this.store.saveAs(); else this.store.save();
    }
  }
}
