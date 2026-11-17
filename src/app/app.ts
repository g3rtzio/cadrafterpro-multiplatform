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

// Main window — port of ContentView.swift:
// left the element tree or the page thumbnails, ribbon on top, the plan (one or two panes)
// in the middle, the status bar at the bottom and the properties panel on the right
@Component({
  selector: 'app-root',
  imports: [Icon, OcrPanel, ColumnsDialog, FilterBuilder, EstimateView, LayoutsPanel, PlanView, PropertiesDialog, SidePanel, Ribbon, ScaleDialog, StatusBar, TakeoffTree, TemplatesView, Thumbnails],
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
      <aside class="sidebar">
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
        <span class="title">{{ s.fileName || 'CadrafterPro' }}</span>
        <span class="spacer"></span>
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
        <div class="plan-area" [class.vertical]="s.splitMode === 'vertical'" [class.horizontal]="s.splitMode === 'horizontal'">
          @for (pane of panes(); track pane) {
            <div class="pane" [class.active-pane]="s.splitMode !== 'single' && s.activePane === pane">
              @if (s.splitMode !== 'single') {
                <div class="pane-bar" (mousedown)="s.activate(pane)">
                  <span class="secondary small">{{ s.pageName(s.pageIndexes[pane]) }}</span>
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
    @if (s.columnsOpen) {
      <app-columns-dialog />
    }
  `,
})
export class App {
  readonly store = inject(DrawingStore);
  readonly ocr = inject(OcrService);
  readonly showSidebar = signal(true);
  readonly showInspector = signal(true);
  readonly sidebarMode = signal<'elements' | 'pages'>('elements');
  readonly sidebarFilter = signal('');               // search box above the Elements / Pages list

  constructor() {
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
      const [handle] = await picker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const file = await handle.getFile();
      await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name, handle);
    } catch {
      // cancelled
    }
  }

  // Safari and Firefox: a hidden file input made on the fly
  private pickWithInput(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name, null);
    });
    input.click();
  }

  // Drop a PDF on the window. The file and its handle are read before any await:
  // the dropped items stop working as soon as the event ends.
  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const item = [...(event.dataTransfer?.items ?? [])].find(i => i.kind === 'file');
    if (!item) return;
    const file = item.getAsFile();
    const withHandle = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
    const pendingHandle = withHandle.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null);
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;
    const handle = await pendingHandle;
    await this.store.open(new Uint8Array(await file.arrayBuffer()), file.name,
      handle && handle.kind === 'file' ? handle as FileSystemFileHandle : null);
  }

  // ⌘O opens a drawing, ⌘S saves, ⇧⌘S saves a copy, ⌘Z undoes, ⇧⌘Z / Ctrl+Y redoes
  onKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
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
