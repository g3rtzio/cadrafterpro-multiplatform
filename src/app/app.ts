import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { EstimateView } from './components/estimate-view/estimate-view';
import { PlanView } from './components/plan-view/plan-view';
import { PropertiesPanel } from './components/properties-panel/properties-panel';
import { Ribbon } from './components/ribbon/ribbon';
import { ColumnsDialog } from './components/columns-dialog/columns-dialog';
import { PropertiesDialog } from './components/properties-dialog/properties-dialog';
import { ScaleDialog } from './components/scale-dialog/scale-dialog';
import { StatusBar } from './components/status-bar/status-bar';
import { TakeoffTree } from './components/takeoff-tree/takeoff-tree';
import { Thumbnails } from './components/thumbnails/thumbnails';
import { DrawingStore } from './services/drawing.store';

// Main window — port of ContentView.swift:
// left the element tree or the page thumbnails, ribbon on top, the plan (one or two panes)
// in the middle, the status bar at the bottom and the properties panel on the right
@Component({
  selector: 'app-root',
  imports: [
    ColumnsDialog,
    EstimateView,
    PlanView,
    PropertiesDialog,
    PropertiesPanel,
    Ribbon,
    ScaleDialog,
    StatusBar,
    TakeoffTree,
    Thumbnails,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'app',
    '(document:keydown)': 'onKey($event)',
    '(dragover)': '$event.preventDefault()',
    '(drop)': 'onDrop($event)',
  },
  template: `
    @let s = store.watch();
    <!-- Left: page thumbnails or the element tree -->
    @if (showSidebar()) {
      <aside class="sidebar">
        <div class="segmented sidebar-picker">
          <button
            [class.active]="sidebarMode() === 'elements'"
            (click)="sidebarMode.set('elements')"
          >
            Elements
          </button>
          <button [class.active]="sidebarMode() === 'pages'" (click)="sidebarMode.set('pages')">
            Pages
          </button>
        </div>
        @if (sidebarMode() === 'elements') {
          <app-takeoff-tree />
        } @else {
          <app-thumbnails />
        }
      </aside>
    }

    <main class="main">
      <!-- Title bar: file name, pages, zoom and panels -->
      <header class="titlebar">
        <button class="icon-button" title="Sidebar" (click)="showSidebar.set(!showSidebar())">
          <span class="icon">left_panel_open</span>
        </button>
        <span class="title">{{ s.fileName || 'CadrafterPro' }}</span>
        <span class="spacer"></span>
        <button class="icon-button" title="Previous Page" (click)="s.previousPage()">
          <span class="icon">chevron_left</span>
        </button>
        <button class="icon-button" title="Next Page" (click)="s.nextPage()">
          <span class="icon">chevron_right</span>
        </button>
        <button class="icon-button" title="Zoom Out" (click)="s.zoomOut()">
          <span class="icon">zoom_out</span>
        </button>
        <button class="icon-button" title="Fit" (click)="s.fitPage()">
          <span class="icon">fit_screen</span>
        </button>
        <button class="icon-button" title="Zoom In" (click)="s.zoomIn()">
          <span class="icon">zoom_in</span>
        </button>
        <button
          class="icon-button"
          title="Properties"
          (click)="showInspector.set(!showInspector())"
        >
          <span class="icon">right_panel_open</span>
        </button>
      </header>

      <!-- Top: toolbar with tabs (Home / Estimating) -->
      <app-ribbon (openFile)="openFile()" />

      <!-- Center: the plan (one or two panes), or the estimate table on top of it -->
      <div class="center">
        <div
          class="plan-area"
          [class.vertical]="s.splitMode === 'vertical'"
          [class.horizontal]="s.splitMode === 'horizontal'"
        >
          @for (pane of panes(); track pane) {
            <div
              class="pane"
              [class.active-pane]="s.splitMode !== 'single' && s.activePane === pane"
            >
              @if (s.splitMode !== 'single') {
                <div class="pane-bar" (mousedown)="s.activate(pane)">
                  <span class="secondary small">{{ s.pageName(s.pageIndexes[pane]) }}</span>
                  <span class="spacer"></span>
                  <button class="icon-button" title="Close This View" (click)="s.closePane(pane)">
                    <span class="icon small">close</span>
                  </button>
                </div>
              }
              <app-plan-view [pane]="pane" />
            </div>
          }
        </div>
        @if (s.ribbonTab === 'Estimating') {
          <app-estimate-view />
        }

        <!-- Short message after saving or exporting -->
        @if (s.toastMessage) {
          <div class="toast" [class.error]="s.toastIsError">
            <span class="icon small">{{ s.toastIsError ? 'warning' : 'check_circle' }}</span>{{
              s.toastMessage
            }}
          </div>
        }
      </div>

      <!-- Bottom: Revu-style status bar -->
      <app-status-bar />
    </main>

    <!-- Right: properties panel -->
    @if (showInspector()) {
      <aside class="inspector"><app-properties-panel /></aside>
    }

    <!-- Scale dialog (page scale, viewport, or asked before measuring); a new one for every request -->
    @for (request of s.scaleRequest ? [s.scaleRequest] : []; track request.id) {
      <app-scale-dialog />
    }

    <!-- Estimate: Properties of a row (a new window for every row) and the Columns window -->
    @for (key of s.propertiesKey ? [s.propertiesKey] : []; track key) {
      <app-properties-dialog [rowKey]="key" />
    }
    @if (s.columnsOpen) {
      <app-columns-dialog />
    }
  `,
})
export class App {
  readonly store = inject(DrawingStore);
  readonly showSidebar = signal(true);
  readonly showInspector = signal(true);
  readonly sidebarMode = signal<'elements' | 'pages'>('elements');

  constructor() {
    loadIconFont();
  }

  panes(): number[] {
    return this.store.watch().splitMode === 'single' ? [0] : [0, 1];
  }

  // Open File: with the File System Access API (Chrome, Edge) Save can write over the same file;
  // other browsers use a normal file picker and Save downloads a copy
  async openFile(): Promise<void> {
    const picker = (
      window as unknown as { showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]> }
    ).showOpenFilePicker;
    if (!picker) {
      this.pickWithInput();
      return;
    }
    try {
      const [handle] = await picker({
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
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
    const item = [...(event.dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
    if (!item) return;
    const file = item.getAsFile();
    const withHandle = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    };
    const pendingHandle =
      withHandle.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null);
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;
    const handle = await pendingHandle;
    await this.store.open(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
      handle && handle.kind === 'file' ? (handle as FileSystemFileHandle) : null,
    );
  }

  // ⌘O opens a drawing, ⌘S saves, ⇧⌘S saves a copy, ⌘Z undoes, ⇧⌘Z / Ctrl+Y redoes
  onKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    // While typing in a text field, Undo belongs to the field
    const target = e.target as HTMLElement | null;
    const textInput =
      target instanceof HTMLInputElement &&
      /^(text|search|number|email|url|tel|password)$/.test(target.type);
    const typing =
      textInput || target instanceof HTMLTextAreaElement || !!target?.isContentEditable;
    if ((key === 'z' || key === 'y') && !typing) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if (key === 'o') {
      e.preventDefault();
      this.openFile();
    } else if (key === 's') {
      e.preventDefault();
      if (e.shiftKey) this.store.saveAs();
      else this.store.save();
    }
  }
}

// Material Symbols icon font (Google Fonts stylesheet added once to the document head)
function loadIconFont(): void {
  const id = 'material-symbols-font';
  if (document.getElementById(id)) return;
  const sheet = document.createElement('link');
  sheet.id = id;
  sheet.rel = 'stylesheet';
  sheet.href =
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,300..500,0..1,0';
  document.head.appendChild(sheet);
}
