import { Injectable, computed, signal } from '@angular/core';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, degrees as pdfDegrees } from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Markup, Measurement, PlanElement } from '../../models/elements';
import {
  AREA_UNITS, COLORS, boundsOf, LENGTH_UNITS, LengthUnit, LineStyle, Pt, Rect, ScaleViewport, TakeoffItem, TakeoffKind,
  isArchitecturalScale, kindTitle, kindUnit, netPolygonArea, pointInPolygon, polygonArea, polylineLength, quantityText, rectContains,
  scaleName, uid,
} from '../../models/takeoff';
import { FilterGroup, NamedFilter, isFilterEmpty, matchesFilter, parseFilter } from '../../models/estimate-filter';
import { readPage, readPdf, writePdf } from '../pdf-file/pdf-file';
import { PageGeometry, SnapIndex, openRenderer } from '../pdf-render/pdf-render';
import { Cell, xlsxBlob } from '../xlsx/xlsx';
import {
  ColumnDef, ElementKind, EstimateData, EstimateGroup, EvalNode, EvalResult, Part, PropertyDef, TAKEOFF_PROPS,
  SLOPE_FACTOR_FORMULAS, TakeoffValues, defaultColumns, elementTemplate, emptyEstimate, evaluate, findProp, formatResult, partTemplate, upgradeProps,
} from '../../models/estimate';

// Port of DrawingViewModel.swift: the whole state of the app.
// Plain fields hold the data; every change calls touch(), and the views read watch()
// so they redraw (the same idea as the `_ = revision` reads on the Mac).

export type SplitMode = 'single' | 'vertical' | 'horizontal';
export type RibbonTab = 'Home' | 'Page' | 'Estimating' | 'Templates' | 'Cost Database';
export type InteractionMode = 'pan' | 'select' | 'zoom';
export type Tool = 'none' | 'count' | 'length' | 'area';

// What the scale dialog is setting: a page, an existing viewport or a new one
export type ScaleTarget =
  | { type: 'page'; pageIndex: number }
  | { type: 'viewport'; id: string }
  | { type: 'newViewport'; pageIndex: number; rect: Rect };

// Open scale dialog. pendingItemId: takeoff to start once the page has a scale
export interface ScaleRequest { id: string; target: ScaleTarget; pendingItemId?: string; }

// What each plan pane can do for the model (zoom, fit, show a region)
export interface PaneApi {
  zoomBy(factor: number): void;
  fitPage(): void;
  fitWidth(): void;
  showRect(rect: Rect): void;              // page coordinates
}

// A group = markups on one page with the same name
export interface MarkupGroup { name: string; markups: Markup[]; color: string; isVisible: boolean; }

// One row of the estimate: a folder (one per takeoff type) or an element inside it
export interface EstimateRow {
  id: string;
  key: string;                     // element name, part id or group id
  kind: 'folder' | 'element' | 'part';
  name: string;
  isFolder: boolean;
  color?: string;
  quantity?: number;
  unit: string;
  pages: string;
  children: EstimateRow[];         // rows of a group
  subRows: EstimateRow[];          // parts under an element or part (sub-items)
}

// State saved for Undo / Redo
interface Snapshot {
  measurements: [Measurement, Record<string, unknown>][];
  markups: [Markup, Record<string, unknown>][];
  removed: { pageIndex: number; ref: PDFRef }[];
  items: TakeoffItem[];
  pageScales: Map<number, number>;
  viewports: ScaleViewport[];
  current: Measurement | null;
  countSession: Measurement[];
  estimate: EstimateData;
  pageNames: Map<number, string>;
}

// Markup fields that, when Undo changes them, mean the markup must be written again
const MARKUP_FIELDS = ['pageIndex', 'rect', 'vertices', 'line', 'inkList', 'visible', 'subject', 'contents',
  'color', 'fillColor', 'lineWidth', 'cutouts'] as const;

// An element's own fields, without its identity and its PDF object (those never go back)
function stateOf(el: object): Record<string, unknown> {
  const { id, ref, pdfRef, ...rest } = el as Record<string, unknown>;
  return rest;
}

// Overlay: another page drawn over a base page in its own color, moved and scaled to line up
export interface OverlayState {
  baseIndex: number;                      // page underneath
  sourceIndex: number;                    // page drawn on top
  baseColor: string | null;               // null = the base page keeps its own colors
  overlayColor: string;
  opacity: number;                        // of the page on top (0 to 1)
  dx: number;                             // offset of the page on top, in view units of the base page
  dy: number;
  scale: number;
  rotation: number;                       // degrees, around the center of the page on top
  adjusting: boolean;                     // dragging on the plan moves the page on top
}

// Region copied with the Snapshot tool (picture and its size on paper)
export interface SnapshotClip {
  url: string;                            // data URL shown on the plan
  jpeg: Uint8Array;                       // written into the PDF when it is pasted and saved
  w: number;                              // size in view units (PDF points at 100 %)
  h: number;
}

// "Insert Pages" dialog: a PDF that was picked, waiting for the pages and the position
export interface InsertRequest {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  at: number;                             // suggested position (index the first new page takes)
}

// One page of the document after adding, deleting or moving pages
// An existing page (old index), an existing page whose drawing is replaced (Slip Sheet: same
// index, so everything on it stays), or a new page
type PageSlot =
  | { old: number; page?: PDFPage; geometry?: PageGeometry }
  | { page: PDFPage; geometry: PageGeometry; label: string };

// Live points of the measurement in progress (for the live layer)
export interface LivePoints { pageIndex: number; points: Pt[]; }

const PALETTE = [COLORS.green, COLORS.blue, COLORS.orange, COLORS.red, COLORS.purple,
  COLORS.pink, COLORS.yellow, COLORS.cyan, COLORS.mint, COLORS.brown];

@Injectable({ providedIn: 'root' })
export class DrawingStore {
  // MARK: - Change tracking
  private readonly rev = signal(0);
  // Every view reads this; it fires after every touch()
  readonly watch = computed(() => { this.rev(); return this; }, { equal: () => false });
  // Fires while something is dragged (only the plan needs to redraw)
  readonly geometry = signal(0);

  touch(): void { this.rev.update(v => v + 1); }

  // MARK: - Document
  lib: PDFDocument | null = null;                  // pdf-lib: reads and writes the file
  renderer: PDFDocumentProxy | null = null;        // pdf.js: draws the pages
  pages: PageGeometry[] = [];
  fileName = '';
  fileHandle: FileSystemFileHandle | null = null;  // file that was opened (Save writes here)
  pageNames = new Map<number, string>();           // names the user gives to pages
  pageLabels: string[] = [];                       // page labels stored in the PDF
  loading = false;
  private extraRenderers: PDFDocumentProxy[] = [];  // pdf.js documents of inserted pages (blank or from other files)
  private pagesChanged = false;                    // pages added, deleted or moved since opening (labels rewritten on save)

  get pageCount(): number { return this.pages.length; }
  get hasDocument(): boolean { return this.lib !== null; }

  // MARK: - App measurements
  // One default item for each takeoff tool
  items: TakeoffItem[] = [
    { id: uid(), name: 'Area', kind: 'area', color: COLORS.green, isVisible: true },
    { id: uid(), name: 'Linear', kind: 'length', color: COLORS.blue, isVisible: true },
    { id: uid(), name: 'Segment', kind: 'segment', color: COLORS.orange, isVisible: true },
    { id: uid(), name: 'Count', kind: 'count', color: COLORS.red, isVisible: true },
  ];
  selectedItemId: string | null = null;
  continuingTemplate: Markup | null = null;       // PDF element copied on every click (green dot)
  continuedGroupName: string | null = null;       // PDF group whose measurement is being continued
  measurements: Measurement[] = [];
  markups: Markup[] = [];
  private removed: { pageIndex: number; ref: PDFRef }[] = [];
  pageScales = new Map<number, number>();         // scale of each page (page index → denominator)
  viewports: ScaleViewport[] = [];                // regions with their own scale
  scaleRequest: ScaleRequest | null = null;       // scale dialog on screen
  drawingViewport = false;                        // dragging a box on the plan to add a viewport
  private current: Measurement | null = null;
  private countSession: Measurement[] = [];       // counts of this session
  private snapIndexes = new Map<number, SnapIndex | 'loading'>();

  // Snap: measuring clicks jump to the drawing's vertices (on by default, remembered between launches)
  private snap = readSetting('snapEnabled') !== 'false';
  get snapEnabled(): boolean { return this.snap; }
  set snapEnabled(value: boolean) { this.snap = value; writeSetting('snapEnabled', String(value)); this.touch(); }
  // Ortho: new points go straight across or straight up/down from the previous one (Shift does it while held)
  private ortho = readSetting('orthoEnabled') === 'true';
  get orthoEnabled(): boolean { return this.ortho; }
  set orthoEnabled(value: boolean) { this.ortho = value; writeSetting('orthoEnabled', String(value)); this.touch(); }
  // Last point of the measurement being drawn (Ortho lines up the next one with it)
  get lastMeasuredPoint(): { pageIndex: number; point: Pt } | null {
    const c = this.current;
    return c && c.points.length ? { pageIndex: c.pageIndex, point: c.points[c.points.length - 1] } : null;
  }

  // Unit for new measurements (the last one chosen in Properties)
  private lengthUnit: LengthUnit = (LENGTH_UNITS as string[]).includes(readSetting('lengthUnit') ?? '')
    ? readSetting('lengthUnit') as LengthUnit : 'ft';
  get defaultLengthUnit(): LengthUnit { return this.lengthUnit; }
  set defaultLengthUnit(value: LengthUnit) { this.lengthUnit = value; writeSetting('lengthUnit', value); }
  // Areas have their own unit (sf, sy, m²…), the square of a length unit
  private areaUnit: LengthUnit = (AREA_UNITS as string[]).includes(readSetting('areaUnit') ?? '')
    ? readSetting('areaUnit') as LengthUnit : 'ft';
  get defaultAreaUnit(): LengthUnit { return this.areaUnit; }
  set defaultAreaUnit(value: LengthUnit) { this.areaUnit = value === 'ft\' in"' ? 'ft' : value; writeSetting('areaUnit', this.areaUnit); }
  // Unit a new measurement of this kind starts with
  unitFor(kind: TakeoffKind): LengthUnit { return kind === 'area' ? this.defaultAreaUnit : this.defaultLengthUnit; }

  // MARK: - View and tools (bottom bar)
  interaction: InteractionMode = 'select';

  // MARK: - Ribbon tab and estimate table
  ribbonTab: RibbonTab = 'Home';
  estimateCollapsed = new Set<string>();          // folders closed in the estimate table

  // MARK: - Short message at the bottom ("Saved COMBINED.pdf")
  toastMessage: string | null = null;
  toastIsError = false;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  // MARK: - Split view (two independent panes)
  splitMode: SplitMode = 'single';
  activePane = 0;                                 // pane that received the last click
  pageIndexes = [0, 0];                           // page shown in each pane
  private history = [{ back: [] as number[], forward: [] as number[] }, { back: [] as number[], forward: [] as number[] }];
  private paneApis = new Map<number, PaneApi>();

  // Page of the active pane
  get currentPageIndex(): number { return this.pageIndexes[this.activePane]; }

  // MARK: - Selected elements
  selection: PlanElement[] = [];

  // MARK: - Scale
  // Scale of the current page (ribbon, status bar and Properties use this one).
  // null = scale not set (Scale Not Set). Every page keeps its own scale.
  get scaleDenominator(): number | null { return this.pageScales.get(this.currentPageIndex) ?? null; }
  set scaleDenominator(value: number | null) { this.setScale(value, this.currentPageIndex); }

  // Scale at a point: the viewport that contains it, otherwise the page scale (null = not set)
  denominator(pageIndex: number, point?: Pt | null): number | null {
    if (point) {
      const v = [...this.viewports].reverse().find(v => v.pageIndex === pageIndex && rectContains(v.rect, point));
      if (v) return v.denominator;
    }
    return this.pageScales.get(pageIndex) ?? null;
  }

  // Feet per PDF point (1 point = 1/72 inch)
  feetPerPoint(pageIndex: number, point?: Pt | null): number {
    return (1 / 72) / 12 * (this.denominator(pageIndex, point) ?? 1);
  }

  // The page can be measured: it has a page scale or at least one viewport
  hasScale(pageIndex: number): boolean {
    return this.pageScales.has(pageIndex) || this.viewports.some(v => v.pageIndex === pageIndex);
  }

  get scaleText(): string {
    const d = this.scaleDenominator;
    return d === null ? 'Scale Not Set' : 'Scale ' + scaleName(d);
  }

  get selectedItem(): TakeoffItem | undefined {
    return this.items.find(i => i.id === this.selectedItemId);
  }

  get tool(): Tool {
    if (this.continuingTemplate) return 'count';   // every click adds a copy
    const item = this.selectedItem;
    if (!item) return 'none';
    switch (item.kind) {
      case 'count': return 'count';
      case 'length': case 'segment': return 'length';
      case 'area': return 'area';
    }
  }

  // Active measurement type (to highlight its button in the top bar)
  get activeKind(): TakeoffKind | null {
    return this.continuingTemplate ? null : this.selectedItem?.kind ?? null;
  }

  // MARK: - Open a drawing
  async open(bytes: Uint8Array, name: string, handle: FileSystemFileHandle | null): Promise<void> {
    // A file that is already open: show its tab
    const same = this.tabs.find(t => t.name === name);
    if (same) {
      if (!same.active) this.switchTab(same.id);
      this.showToast(`${name} is already open`);
      return;
    }
    this.loading = true;
    this.touch();
    try {
      const [opened, renderer] = await Promise.all([readPdf(bytes), openRenderer(bytes)]);
      const pages = await Promise.all(
        Array.from({ length: renderer.numPages }, (_, i) => renderer.getPage(i + 1).then(p => new PageGeometry(p))));
      const labels = await renderer.getPageLabels().catch(() => null);

      // The open document stays in its tab
      if (this.hasDocument) this.parkActive();
      this.tabOrder.push(this.activeTab = uid());
      this.paneDocs[this.splitMode === 'single' ? 0 : this.activePane] = this.activeTab;
      this.pagesChanged = false;
      this.overlay.set(null);
      this.snapshotMode = 'none';
      this.insertRequest = null;
      this.lib = opened.lib;
      this.renderer = renderer;
      this.pages = pages;
      this.pageLabels = labels ?? [];
      this.fileName = name;
      this.fileHandle = handle;
      this.documentId = uid();
      this.pageIndexes = [0, 0];
      this.history.forEach(h => { h.back = []; h.forward = []; });
      this.measurements = [];
      this.markups = opened.markups;
      this.removed = [];
      this.current = null;
      this.countSession = [];
      this.selection = [];
      this.pageNames = new Map();
      this.pageScales = opened.pageScales;
      this.viewports = opened.viewports;
      this.scaleRequest = null;
      this.drawingViewport = false;
      this.selectedItemId = null;
      this.continuingTemplate = null;
      this.snapIndexes.clear();
      this.undoStack = [];
      this.redoStack = [];
      this.loadEstimate(opened.appData);
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't open ${name}`, true);
    } finally {
      this.loading = false;
      this.touch();
    }
  }

  // MARK: - Close the drawing
  // Leaves the app empty, as when it starts (changes not saved are lost)
  closeDocument(): void {
    if (this.hasDocument) this.closeTab(this.activeTab);
  }

  // Leaves the app empty (the active tab's document is destroyed)
  private resetDocument(): void {
    this.renderer?.destroy();
    this.destroyExtraRenderers();
    this.pagesChanged = false;
    this.overlay.set(null);
    this.snapshotMode = 'none';
    this.insertRequest = null;
    this.lib = null;
    this.renderer = null;
    this.pages = [];
    this.pageLabels = [];
    this.fileName = '';
    this.fileHandle = null;
    this.pageIndexes = [0, 0];
    this.history.forEach(h => { h.back = []; h.forward = []; });
    this.measurements = [];
    this.markups = [];
    this.removed = [];
    this.current = null;
    this.countSession = [];
    this.selection = [];
    this.pageNames = new Map();
    this.pageScales = new Map();
    this.viewports = [];
    this.scaleRequest = null;
    this.drawingViewport = false;
    this.selectedItemId = null;
    this.continuingTemplate = null;
    this.continuedGroupName = null;
    this.snapIndexes.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.estimate = emptyEstimate();
    this.selectedEstimateKey = null;
    this.propertiesKey = null;
    this.columnsOpen = false;
    this.splitMode = 'single';
    this.activePane = 0;
    this.extraPages = new Set();
    this.extraEstimateKeys = new Set();
    this.extractOpen = false;
    this.touch();
  }

  // MARK: - Tabs (several documents open, one shown at a time)
  // The active document lives in the store's fields; the others are parked with their own state
  private tabOrder: string[] = [];
  private activeTab = '';
  private parked = new Map<string, Record<string, unknown>>();
  private static readonly DOC_FIELDS = [
    'lib', 'renderer', 'pages', 'fileName', 'fileHandle', 'pageNames', 'pageLabels', 'extraRenderers', 'pagesChanged',
    'measurements', 'markups', 'removed', 'pageScales', 'viewports', 'countSession', 'snapIndexes',
    'pageIndexes', 'history', 'selection', 'extraPages', 'extraPagesOf', 'pageAnchor',
    'undoStack', 'redoStack', 'lastCheckpoint', 'documentId', 'estimate', 'selectedEstimateKey', 'extraEstimateKeys',
  ] as const;

  get tabs(): { id: string; name: string; active: boolean; edited: boolean }[] {
    return this.tabOrder.map(id => {
      const state = id === this.activeTab ? (this as unknown as Record<string, unknown>) : this.parked.get(id)!;
      return {
        id, active: id === this.activeTab,
        name: String(state['fileName'] ?? ''),
        edited: ((state['undoStack'] as unknown[]) ?? []).length > 0,
      };
    });
  }

  // Moves the active document out of the store's fields (they get fresh containers)
  private parkActive(): void {
    this.finishCurrentMeasurement();
    this.selectedItemId = null;
    this.continuingTemplate = null;
    this.continuedGroupName = null;
    this.scaleRequest = null;
    this.drawingViewport = false;
    this.snapshotMode = 'none';
    this.overlay.set(null);
    this.insertRequest = null;
    this.extractOpen = false;
    this.batchRotateOpen = false;
    this.pitchOpen = false;
    this.propertiesKey = null;
    this.columnsOpen = false;
    const self = this as unknown as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    for (const f of DrawingStore.DOC_FIELDS) state[f] = self[f];
    this.parked.set(this.activeTab, state);
    this.snapIndexes = new Map();
    this.history = [{ back: [], forward: [] }, { back: [], forward: [] }];
    this.extraRenderers = [];
    this.extraPages = new Set();
    this.extraEstimateKeys = new Set();
    this.lib = null;
    this.renderer = null;
  }

  private restoreTab(id: string): void {
    const state = this.parked.get(id);
    if (!state) return;
    this.parked.delete(id);
    Object.assign(this, state);
    this.activeTab = id;
    this.geometry.update(n => n + 1);
    this.touch();
  }

  // A tab picked in the title bar goes to the active view (the other view keeps its document)
  switchTab(id: string): void {
    if (this.splitMode === 'single') {
      this.paneDocs[0] = id;
      this.showDocument(id);
      return;
    }
    const pane = this.activePane, other = 1 - pane;
    const fresh = this.paneDocs[pane] !== id && this.paneDocs[other] !== id;
    this.paneDocs[pane] = id;
    this.showDocument(id);
    // A document new to the split shows its current page in this view
    if (fresh) this.pageIndexes[pane] = this.pageIndexes[other];
    this.touch();
  }

  // Makes a tab the active document (the one the tools, the tree and the panels work on)
  private showDocument(id: string): void {
    if (id === this.activeTab || !this.parked.has(id)) return;
    this.parkActive();
    this.restoreTab(id);
  }

  // MARK: - Documents of the views
  // Each view can show a page of another open document. The active view's document is the active
  // one; the other view draws its document's pages and elements from its parked state.
  paneDocs = ['', ''];
  private views = new WeakMap<Record<string, unknown>, DrawingStore>();

  docView(pane: number): DrawingStore {
    if (this.splitMode === 'single' && pane === 0) return this;
    const id = this.paneDocs[pane];
    const state = id && id !== this.activeTab ? this.parked.get(id) : undefined;
    if (!state) return this;
    let view = this.views.get(state);
    if (!view) {
      // Reads go to the parked document, everything else to the store
      view = Object.assign(Object.create(this) as DrawingStore, state, { selection: [] });
      this.views.set(state, view);
    }
    return view;
  }

  paneDocId(pane: number): string {
    return (this.splitMode !== 'single' && this.paneDocs[pane]) || this.activeTab;
  }

  // Document chosen in a view's bar
  setPaneDoc(pane: number, id: string): void {
    this.activate(pane);
    this.switchTab(id);
  }

  // Closes a tab (changes not saved are lost); the next tab (or the previous one) becomes active
  closeTab(id: string): void {
    const at = this.tabOrder.indexOf(id);
    if (at < 0) return;
    this.tabOrder.splice(at, 1);
    if (id !== this.activeTab) {
      const state = this.parked.get(id);
      this.parked.delete(id);
      (state?.['renderer'] as PDFDocumentProxy | null)?.destroy();
      ((state?.['extraRenderers'] as PDFDocumentProxy[]) ?? []).forEach(r => r.destroy());
      this.paneDocs = this.paneDocs.map(d => d === id ? this.activeTab : d);
      this.touch();
      return;
    }
    const split = this.splitMode, pane = this.activePane;
    // A view showing another document keeps it and becomes the active one
    const otherDoc = split !== 'single' ? this.paneDocs[1 - pane] : '';
    const next = otherDoc && otherDoc !== id ? otherDoc : this.tabOrder[Math.min(at, this.tabOrder.length - 1)];
    this.resetDocument();
    if (next) {
      this.restoreTab(next);
      this.splitMode = split;
      this.activePane = otherDoc && otherDoc !== id ? 1 - pane : pane;
      this.paneDocs = this.paneDocs.map(d => d === id || !this.tabOrder.includes(d) ? next : d);
      this.touch();
    } else {
      this.activeTab = '';
      this.paneDocs = ['', ''];
    }
  }

  // Ctrl+Tab / Ctrl+Shift+Tab
  nextTab(step: number): void {
    const n = this.tabOrder.length;
    if (n < 2) return;
    const at = this.tabOrder.indexOf(this.activeTab);
    this.switchTab(this.tabOrder[(at + step + n) % n]);
  }

  // MARK: - Undo / Redo (Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z)
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastCheckpoint = { key: '', time: 0 };
  private moving = false;

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  // Saves the state before a change. Changes with the same key in a row (a slider, typing a name)
  // become a single step.
  checkpoint(key = ''): void {
    if (!this.hasDocument) return;
    const now = Date.now();
    if (key && key === this.lastCheckpoint.key && now - this.lastCheckpoint.time < 1000) {
      this.lastCheckpoint.time = now;
      return;
    }
    this.lastCheckpoint = { key, time: now };
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
  }

  private snapshot(): Snapshot {
    return {
      measurements: this.measurements.map(m => [m, stateOf(m)]),
      markups: this.markups.map(m => [m, stateOf(m)]),
      removed: [...this.removed],
      items: this.items.map(i => ({ ...i })),
      pageScales: new Map(this.pageScales),
      viewports: this.viewports.map(v => ({ ...v, rect: { ...v.rect } })),
      current: this.current,
      countSession: [...this.countSession],
      estimate: structuredClone(this.estimate),
      pageNames: new Map(this.pageNames),
    };
  }

  private restore(snap: Snapshot): void {
    const present = new Set(this.markups);
    for (const [m, state] of snap.measurements) Object.assign(m, state);
    for (const [m, state] of snap.markups) {
      const record = m as unknown as Record<string, unknown>;
      const changed = !present.has(m) || MARKUP_FIELDS.some(k => record[k] !== state[k]);
      const holes = ['cutouts', 'vertices', 'line'].some(k => record[k] !== state[k]);
      Object.assign(m, state);
      if (changed) m.dirty = true;                     // written again on the next save
      if (holes) m.redrawAppearance = true;              // its picture in the PDF is drawn again
    }
    this.measurements = snap.measurements.map(([m]) => m);
    this.markups = snap.markups.map(([m]) => m);
    this.removed = snap.removed;
    this.items = snap.items;
    this.pageScales = snap.pageScales;
    this.viewports = snap.viewports;
    this.current = snap.current;
    this.countSession = snap.countSession;
    this.estimate = snap.estimate;
    this.pageNames = snap.pageNames ?? this.pageNames;
    if (this.propertiesKey && !this.rowExists(this.propertiesKey)) this.propertiesKey = null;
    this.selection = this.selection.filter(el =>
      el instanceof Measurement ? this.measurements.includes(el) : this.markups.includes(el));
    if (this.continuingTemplate && !this.markups.includes(this.continuingTemplate)) this.continuingTemplate = null;
    if (this.selectedItemId && !this.items.some(i => i.id === this.selectedItemId)) this.selectedItemId = null;
    this.measurements.forEach(m => this.updateCaption(m));
    this.estimateChanged();
  }

  // MARK: - Tabs and messages
  showTab(tab: RibbonTab): void {
    // The estimate and the templates cover the plan: stop measuring and clear the selection first
    if (tab !== 'Home' && tab !== 'Page') {
      this.select(null);
      this.selectElements([]);
    }
    this.ribbonTab = tab;
    this.touch();
  }

  showToast(message: string, isError = false): void {
    this.toastMessage = message;
    this.toastIsError = isError;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastMessage = null; this.touch(); }, 2500);
    this.touch();
  }

  // MARK: - Panes
  registerPane(pane: number, api: PaneApi | null): void {
    if (api) this.paneApis.set(pane, api); else this.paneApis.delete(pane);
  }

  private get paneApi(): PaneApi | undefined { return this.paneApis.get(this.activePane); }

  activate(pane: number): void {
    // A view with another document: that document becomes the active one
    const doc = this.splitMode !== 'single' ? this.paneDocs[pane] : '';
    if (doc && doc !== this.activeTab) this.showDocument(doc);
    if (this.activePane === pane) return;
    this.activePane = pane;
    this.touch();
  }

  setSplit(mode: SplitMode): void {
    if (mode !== 'single' && this.splitMode === 'single') {
      this.pageIndexes[1] = this.pageIndexes[0];
      this.paneDocs = [this.activeTab, this.activeTab];
    }
    // Back to one view: it shows the active document (its page in the active view)
    if (mode === 'single' && this.splitMode !== 'single') {
      if (this.activePane === 1 && this.paneDocs[0] !== this.paneDocs[1]) this.pageIndexes[0] = this.pageIndexes[1];
      this.paneDocs = [this.activeTab, this.activeTab];
    }
    this.splitMode = mode;
    if (mode === 'single') this.activePane = 0;
    this.touch();
  }

  // Closes a pane; the other one becomes the only view
  closePane(index: number): void {
    const other = 1 - index;
    if (this.paneDocs[other] && this.paneDocs[other] !== this.activeTab) this.showDocument(this.paneDocs[other]);
    if (index === 0) this.pageIndexes[0] = this.pageIndexes[1];   // the second pane becomes the only one
    this.activePane = 0;
    this.paneDocs = [this.activeTab, this.activeTab];
    this.splitMode = 'single';
    this.touch();
  }

  // MARK: - Page names
  pageName(index: number): string {
    const name = this.pageNames.get(index);
    if (name) return name;
    const label = this.pageLabels[index];
    if (label && label !== String(index + 1)) return label;
    return `Page ${index + 1}`;
  }

  renamePage(index: number, name: string): void {
    this.checkpoint('page-name');
    const trimmed = name.trim();
    if (trimmed) this.pageNames.set(index, trimmed); else this.pageNames.delete(index);
    this.touch();
  }

  // Create Page Labels: several pages at once (one Undo step)
  renamePages(names: Map<number, string>): void {
    if (names.size === 0) return;
    this.checkpoint();
    for (const [index, name] of names) {
      const trimmed = name.trim();
      if (trimmed) this.pageNames.set(index, trimmed);
    }
    this.touch();
  }

  // Name written into the PDF as its page label ('' = the plain page number)
  private labelToSave(index: number): string {
    const label = this.pageNames.get(index) ?? this.pageLabels[index] ?? '';
    return label === String(index + 1) ? '' : label;
  }

  // MARK: - Page scale
  setScale(denominator: number | null, pageIndex: number): void {
    this.checkpoint();
    if (denominator === null) this.pageScales.delete(pageIndex); else this.pageScales.set(pageIndex, denominator);
    this.scaleChanged(new Set([pageIndex]));
  }

  // Copies the current page's scale to every page
  applyScaleToAllPages(): void {
    this.checkpoint();
    const d = this.scaleDenominator;
    for (let i = 0; i < this.pageCount; i++) {
      if (d === null) this.pageScales.delete(i); else this.pageScales.set(i, d);
    }
    this.scaleChanged(new Set(this.pages.map((_, i) => i)));
    this.showToast(d === null ? 'Scale cleared on all pages' : `Scale ${scaleName(d)} applied to all pages`);
  }

  // MARK: - Scale dialog
  // Opens the dialog for the page scale
  requestPageScale(pageIndex?: number): void {
    if (!this.hasDocument) return;
    this.scaleRequest = { id: uid(), target: { type: 'page', pageIndex: pageIndex ?? this.currentPageIndex } };
    this.touch();
  }

  // Dialog title and starting values
  get scaleRequestTitle(): string {
    const t = this.scaleRequest?.target;
    if (!t) return '';
    return t.type === 'page' ? `Page Scale – ${this.pageName(t.pageIndex)}` : 'Apply Scale to Viewport';
  }

  get scaleRequestIsViewport(): boolean {
    return !!this.scaleRequest && this.scaleRequest.target.type !== 'page';
  }

  get scaleRequestStart(): { denominator: number | null; name: string } {
    const t = this.scaleRequest?.target;
    if (!t) return { denominator: null, name: '' };
    switch (t.type) {
      case 'page':
        return { denominator: this.pageScales.get(t.pageIndex) ?? null, name: 'Page Scale' };
      case 'viewport': {
        const v = this.viewports.find(v => v.id === t.id);
        return { denominator: v?.denominator ?? null, name: v?.name ?? 'Viewport' };
      }
      case 'newViewport': {
        const count = this.viewports.filter(v => v.pageIndex === t.pageIndex).length;
        return { denominator: this.pageScales.get(t.pageIndex) ?? 48, name: count === 0 ? 'Viewport' : `Viewport ${count + 1}` };
      }
    }
  }

  // Apply in the dialog
  applyScaleRequest(denominator: number, name: string): void {
    const request = this.scaleRequest;
    if (!request) return;
    this.scaleRequest = null;
    const label = name.trim();
    const t = request.target;
    if (t.type !== 'page') this.checkpoint();         // the page scale saves its own step
    switch (t.type) {
      case 'page':
        this.setScale(denominator, t.pageIndex);
        break;
      case 'viewport': {
        const v = this.viewports.find(v => v.id === t.id);
        if (!v) return;
        v.denominator = denominator;
        if (label) v.name = label;
        this.scaleChanged(new Set([v.pageIndex]));
        break;
      }
      case 'newViewport':
        this.viewports.push({ id: uid(), name: label || 'Viewport', pageIndex: t.pageIndex, rect: t.rect, denominator });
        this.scaleChanged(new Set([t.pageIndex]));
        break;
    }
    // The takeoff that was waiting for a scale starts now
    if (request.pendingItemId) this.select(request.pendingItemId);
  }

  cancelScaleRequest(): void {
    this.scaleRequest = null;
    this.touch();
  }

  // MARK: - Viewports
  get currentViewports(): ScaleViewport[] {
    return this.viewports.filter(v => v.pageIndex === this.currentPageIndex);
  }

  // "+" in Properties: the next drag on the plan draws the viewport box
  startViewport(): void {
    if (!this.hasDocument) return;
    this.select(null);
    this.drawingViewport = true;
    this.showToast('Drag a box on the plan to define the viewport');
  }

  cancelViewport(): void {
    this.drawingViewport = false;
    this.touch();
  }

  // Box drawn on the plan: ask for its scale
  finishViewport(rect: Rect, pageIndex: number): void {
    this.drawingViewport = false;
    if (rect.w > 2 && rect.h > 2) {
      this.scaleRequest = { id: uid(), target: { type: 'newViewport', pageIndex, rect } };
    }
    this.touch();
  }

  // Boxes drawn on the plan: region and "Viewport · 1/4\" = 1'-0\""
  viewportBoxes(pageIndex: number): { rect: Rect; title: string }[] {
    return this.viewports
      .filter(v => v.pageIndex === pageIndex)
      .map(v => ({ rect: v.rect, title: `${v.name} · ${scaleName(v.denominator)}` }));
  }

  editViewport(id: string): void {
    this.scaleRequest = { id: uid(), target: { type: 'viewport', id } };
    this.touch();
  }

  deleteViewport(id: string): void {
    const v = this.viewports.find(v => v.id === id);
    if (!v) return;
    this.checkpoint();
    this.viewports = this.viewports.filter(x => x.id !== id);
    this.scaleChanged(new Set([v.pageIndex]));
  }

  // Quantities and captions of the measurements on those pages follow the new scale
  private scaleChanged(pages: Set<number>): void {
    this.measurements.filter(m => pages.has(m.pageIndex)).forEach(m => this.updateCaption(m));
    this.touch();
  }

  // MARK: - Zoom and navigation
  zoomIn(): void { this.paneApi?.zoomBy(1.25); }
  zoomOut(): void { this.paneApi?.zoomBy(0.8); }
  fitPage(): void { this.paneApi?.fitPage(); }
  fitWidth(): void { this.paneApi?.fitWidth(); }
  nextPage(): void { this.goTo(this.currentPageIndex + 1); }
  previousPage(): void { this.goTo(this.currentPageIndex - 1); }
  firstPage(): void { this.goTo(0); }
  lastPage(): void { this.goTo(this.pageCount - 1); }

  // MARK: - Selected pages (Pages panel and page rows of the tree: Ctrl/⌘ + click, Shift + click)
  // The current page is always one of them. A new page list starts over.
  private extraPages = new Set<number>();
  private extraPagesOf: unknown = null;
  private pageAnchor: number | null = null;

  get selectedPages(): number[] {
    const extra = this.extraPagesOf === this.pages ? this.extraPages : new Set<number>();
    return [...new Set([this.currentPageIndex, ...extra])].filter(i => i < this.pageCount).sort((a, b) => a - b);
  }

  setSelectedPages(list: Iterable<number>): void {
    this.extraPages = new Set(list);
    this.extraPagesOf = this.pages;
    this.touch();
  }

  clickPage(index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
    if (e.shiftKey) {
      const from = this.pageAnchor ?? this.currentPageIndex;
      const range: number[] = [];
      for (let i = Math.min(from, index); i <= Math.max(from, index); i++) range.push(i);
      this.setSelectedPages(range);
      this.goTo(index);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(this.selectedPages);
      if (set.has(index) && set.size > 1) {
        set.delete(index);
        if (index === this.currentPageIndex) this.goTo([...set][0]);
      } else {
        set.add(index);
        this.goTo(index);
      }
      this.setSelectedPages(set);
      this.pageAnchor = index;
      return;
    }
    this.setSelectedPages([]);
    this.pageAnchor = index;
    this.goTo(index);
  }

  goTo(pageIndex: number, pane = this.activePane): void {
    if (pageIndex < 0 || pageIndex >= this.pageCount || pageIndex === this.pageIndexes[pane]) return;
    const h = this.history[pane];
    h.back.push(this.pageIndexes[pane]);
    h.forward = [];
    this.pageIndexes[pane] = pageIndex;
    this.touch();
  }

  // Go to a page by typing its number ("4") or its name ("G-002")
  goToInput(input: string): void {
    const text = input.trim();
    const number = Number(text);
    if (Number.isInteger(number) && number >= 1 && number <= this.pageCount) {
      this.goTo(number - 1);
      return;
    }
    const index = this.pages.findIndex((_, i) =>
      this.pageName(i).toLowerCase() === text.toLowerCase() || this.pageLabels[i] === text);
    if (index >= 0) this.goTo(index);
  }

  get canGoBack(): boolean { return this.history[this.activePane].back.length > 0; }
  get canGoForward(): boolean { return this.history[this.activePane].forward.length > 0; }

  goBack(): void {
    const h = this.history[this.activePane];
    const previous = h.back.pop();
    if (previous === undefined) return;
    h.forward.push(this.currentPageIndex);
    this.pageIndexes[this.activePane] = previous;
    this.touch();
  }

  goForward(): void {
    const h = this.history[this.activePane];
    const next = h.forward.pop();
    if (next === undefined) return;
    h.back.push(this.currentPageIndex);
    this.pageIndexes[this.activePane] = next;
    this.touch();
  }

  // Shows an element's region on the plan (tree click)
  showElement(el: PlanElement): void {
    this.goTo(el.pageIndex);
    const api = this.paneApi;
    setTimeout(() => api?.showRect(el.bounds), 60);    // after the page is loaded
  }

  // MARK: - View modes
  setInteraction(mode: InteractionMode): void {
    this.select(null);                                  // leaves measuring mode
    this.interaction = mode;
    this.touch();
  }

  // "48.00 x 36.00 in"
  pageSizeText(index: number): string {
    return this.pages[index]?.sizeText ?? '';
  }

  // MARK: - Elements of a page
  elementsOn(pageIndex: number): PlanElement[] {
    return [
      ...this.markups.filter(m => m.pageIndex === pageIndex && m.isPlanElement),
      ...this.measurements.filter(m => m.pageIndex === pageIndex),
    ];
  }

  // The element under the cursor. If several overlap, the smallest wins
  // (so a count on top of a large area can be selected)
  elementAt(pageIndex: number, point: Pt, margin: number): PlanElement | null {
    let best: PlanElement | null = null;
    let bestArea = Infinity;
    for (const el of this.elementsOn(pageIndex)) {
      if (!el.visible || !rectContains(el.bounds, point, margin)) continue;
      const area = el.bounds.w * el.bounds.h;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  // Groups of PDF markups on a page (same name), for the tree and the estimate
  markupGroups(pageIndex: number): MarkupGroup[] {
    const groups = new Map<string, Markup[]>();
    for (const m of this.markups) {
      if (m.pageIndex !== pageIndex || !m.isPlanElement) continue;
      const list = groups.get(m.name);
      if (list) list.push(m); else groups.set(m.name, [m]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, markups]) => ({
        name, markups,
        color: markups[0].color ?? COLORS.gray,
        isVisible: markups[0].visible,
      }));
  }

  // MARK: - Selecting elements
  selectElements(elements: PlanElement[]): void {
    this.selection = elements;
    this.touch();
  }

  isSelected(el: PlanElement): boolean {
    return this.selection.includes(el);
  }

  setVisible(elements: PlanElement[], visible: boolean): void {
    this.checkpoint('visible');
    for (const el of elements) {
      el.visible = visible;
      if (el instanceof Markup) el.dirty = true;
    }
    this.touch();
  }

  // Selection made on the plan. additive = Shift/⌘: adds or removes without losing the rest
  selectFromPlan(elements: PlanElement[], additive: boolean): void {
    if (!additive) return this.selectElements(elements);
    const list = [...this.selection];
    for (const el of elements) {
      const i = list.indexOf(el);
      if (i >= 0) list.splice(i, 1); else list.push(el);
    }
    this.selectElements(list);
  }

  // MARK: - Moving the selection (mouse drag)
  moveSelected(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (!this.moving) {
      this.checkpoint();                               // one Undo step for the whole drag
      this.moving = true;
    }
    this.selection.forEach(el => el.move(dx, dy));
    this.geometry.update(v => v + 1);                  // only the plan redraws while dragging
  }

  // On mouse up: update the quantities and the element list
  finishMove(): void {
    this.moving = false;
    this.selection.forEach(el => { if (el instanceof Measurement) this.updateCaption(el); });
    this.touch();
  }

  // MARK: - Vertices (drag the squares of the selected line or area)
  // The points that can be dragged: lines and areas measured in the app, and PDF polygons,
  // polylines and lines (Revu measurements included). Counts and other shapes have none.
  editableVertices(el: PlanElement): Pt[] | null {
    if (el instanceof Measurement) return el.kind !== 'count' && el.points.length >= 2 ? el.points : null;
    if (el.isRevuMeasurement && /Count/.test(el.intent)) return null;
    if ((el.subtype === 'Polygon' || el.subtype === 'PolyLine') && el.vertices && el.vertices.length >= 2) return el.vertices;
    if (el.subtype === 'Line' && el.line && el.line.length === 2) return el.line;
    return null;
  }

  // Value and text of a Revu measurement when the drag starts (its /Contents follows the new shape)
  private vertexStart: { el: Markup; geometry: number; contents: string } | null = null;

  beginVertexEdit(el: PlanElement): void {
    this.checkpoint();
    this.vertexStart = el instanceof Markup ? { el, geometry: markupGeometry(el), contents: el.contents } : null;
  }

  moveVertex(el: PlanElement, index: number, point: Pt): void {
    const set = (list: Pt[]) => list.map((p, i) => i === index ? { ...point } : p);
    if (el instanceof Measurement) {
      el.points = set(el.points);
      this.updateCaption(el);
    } else {
      if (el.subtype === 'Line' && el.line) el.line = set(el.line);
      else if (el.vertices) el.vertices = set(el.vertices);
      const pts = el.line && el.subtype === 'Line' ? el.line : el.vertices ?? [];
      el.rect = boundsOf(pts, Math.max(el.lineWidth, 1) + 14);   // room for the value text
      el.dirty = true;
      el.redrawAppearance = true;
      const start = this.vertexStart;
      if (start && start.el === el && el.isRevuMeasurement && start.geometry > 0) {
        el.contents = scaleQuantityText(start.contents, markupGeometry(el) / start.geometry);
      }
    }
    this.geometry.update(v => v + 1);                  // only the plan redraws while dragging
  }

  finishVertexEdit(): void {
    this.vertexStart = null;
    this.touch();
  }

  // MARK: - Copy / Paste (Ctrl+C / Ctrl+V) of measurements and markups
  private clipboard: { elements: PlanElement[]; documentId: string; lib: PDFDocument | null; pastes: number } | null = null;
  clipboardKind: 'elements' | 'snapshot' | null = null;   // what Ctrl+V pastes (the last thing copied)
  documentId = uid();                                      // a new one for every document opened

  get canPaste(): boolean { return !!this.clipboard?.elements.length; }

  copySelection(): boolean {
    const list = this.selection.filter(el => el instanceof Measurement || el instanceof Markup);
    if (!list.length) return false;
    this.clipboard = { elements: [...list], documentId: this.documentId, lib: this.lib, pastes: 0 };
    this.clipboardKind = 'elements';
    this.showToast(`Copied ${list.length} element${list.length === 1 ? '' : 's'}`);
    return true;
  }

  // Pastes the copied elements on the page: centered on `at` (the cursor) when given, otherwise
  // a little below and to the right of the originals each time
  pasteElements(pageIndex: number, at: Pt | null): void {
    const clip = this.clipboard;
    if (!clip || !this.hasDocument || !this.pages[pageIndex]) return;
    const sameDocument = clip.documentId === this.documentId;
    const sources = clip.elements;
    const boxes = sources.map(el => el.bounds);
    const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
    const maxX = Math.max(...boxes.map(b => b.x + b.w)), maxY = Math.max(...boxes.map(b => b.y + b.h));
    clip.pastes++;
    const step = 12 * clip.pastes;
    const dx = at ? at.x - (minX + maxX) / 2 : step;
    const dy = at ? at.y - (minY + maxY) / 2 : -step;           // page y goes up: below = minus
    this.checkpoint();
    const pasted: PlanElement[] = [];
    for (const el of sources) {
      if (el instanceof Measurement) {
        const item = this.pasteItemFor(el);
        if (!item) continue;
        const m = new Measurement(el.kind, pageIndex, item.id);
        const { id: _id, nm: _nm, pdfRef: _ref, createdAt: _created, itemId: _item, pageIndex: _page, ...style } = el as unknown as Record<string, unknown>;
        Object.assign(m, style);
        m.points = el.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        m.cutouts = el.cutouts.map(h => h.map(p => ({ x: p.x + dx, y: p.y + dy })));
        m.visible = true;
        this.updateCaption(m);
        this.measurements.push(m);
        pasted.push(m);
      } else {
        const b = el.bounds;
        const copy = el.copy({ x: b.x + b.w / 2 + dx, y: b.y + b.h / 2 + dy });
        copy.pageIndex = pageIndex;
        // From another document: on save its PDF object is copied over from that file
        if (!sameDocument && !el.appMade && !el.templateLib) copy.templateLib = clip.lib;
        this.markups.push(copy);
        pasted.push(copy);
      }
    }
    this.selection = pasted;
    this.touch();
  }

  // The element a pasted measurement belongs to: the same one, or one with its name and type
  // (pasting into another document), created when missing
  private pasteItemFor(m: Measurement): TakeoffItem | null {
    const own = this.items.find(i => i.id === m.itemId);
    if (own) return own;
    const name = m.name || kindTitle(m.kind);
    const same = this.items.find(i => i.name === name && i.kind === m.kind);
    if (same) return same;
    this.addItem(name, m.kind, m.lineColor);
    const added = this.items[this.items.length - 1];
    this.cancelTool();                                       // addItem starts measuring with it
    if (m.fillColor) added.fillColor = m.fillColor;
    return added;
  }

  deleteSelected(): void {
    if (this.selection.length === 0) return;
    this.checkpoint();
    this.removeElements(new Set<PlanElement>(this.selection));
    this.touch();
  }

  // Takes elements off the plan. An element of the estimate that is left with nothing on the plan
  // goes away with its parts and properties (deleting in the estimate and on the plan is the same).
  private removeElements(gone: Set<PlanElement>): void {
    const before = new Set(this.elementNames());
    // If the measurement in progress is deleted, let it go
    if (this.current && gone.has(this.current)) this.current = null;
    this.countSession = this.countSession.filter(m => !gone.has(m));
    for (const el of gone) {
      const ref = el instanceof Markup ? el.ref : el.pdfRef;
      if (ref) this.removed.push({ pageIndex: el.pageIndex, ref });
    }
    this.markups = this.markups.filter(m => !gone.has(m));
    this.measurements = this.measurements.filter(m => !gone.has(m));
    if (this.continuingTemplate && gone.has(this.continuingTemplate)) this.continuingTemplate = null;
    this.selection = this.selection.filter(el => !gone.has(el));
    const after = new Set(this.elementNames());
    const lost = [...before].filter(name => !after.has(name));
    if (lost.length) {
      // The estimate rows of those elements (the takeoff items stay, to measure with them again)
      const lostSet = new Set(lost);
      const keys = new Set<string>(lost);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of this.estimate.parts) {
          if (p.parentKey && keys.has(p.parentKey) && !keys.has(p.id)) { keys.add(p.id); grew = true; }
        }
      }
      this.estimate.parts = this.estimate.parts.filter(p => !keys.has(p.id));
      for (const name of lost) delete this.estimate.elementProps[name];
      for (const g of this.estimateGroups) g.rowNames = g.rowNames.filter(n => !lostSet.has(n));
      if (this.selectedEstimateKey && keys.has(this.selectedEstimateKey)) this.selectedEstimateKey = null;
      this.extraEstimateKeys = new Set([...this.extraEstimateKeys].filter(k => !keys.has(k)));
      this.estimateChanged();
    }
  }

  // Everything on the plan that makes the element `name` of the estimate
  private elementsNamed(name: string): PlanElement[] {
    const ids = new Set(this.items.filter(i => i.name === name).map(i => i.id));
    return [...this.measurements.filter(m => ids.has(m.itemId)), ...this.markups.filter(m => m.isPlanElement && m.name === name)];
  }

  // Takeoff item an app measurement belongs to
  itemFor(el: PlanElement): TakeoffItem | undefined {
    return el instanceof Measurement ? this.items.find(i => i.id === el.itemId) : undefined;
  }

  // MARK: - Editable properties (applied to everything selected)
  // Name: on an app measurement it renames the item (tree and Subject of all its measurements)
  get selectionName(): string {
    const first = this.selection[0];
    if (!first) return '';
    return this.itemFor(first)?.name ?? first.name;
  }
  set selectionName(value: string) {
    this.checkpoint('name');
    const itemIds = new Set(this.selection.map(el => this.itemFor(el)?.id).filter((id): id is string => !!id));
    itemIds.forEach(id => this.renameItem(id, value));
    this.selection.forEach(el => { if (el instanceof Markup) el.name = value; });
    this.touch();
  }

  get selectionContents(): string { return this.selection[0]?.contents ?? ''; }
  set selectionContents(value: string) {
    this.checkpoint('contents');
    this.selection.forEach(el => { if (el instanceof Markup) { el.contents = value; el.dirty = true; } });
    this.touch();
  }

  get selectionVisible(): boolean { return this.selection[0]?.visible ?? true; }
  set selectionVisible(value: boolean) { this.setVisible(this.selection, value); }

  // App measurements among the selected elements
  get selectedMeasurements(): Measurement[] {
    return this.selection.filter((el): el is Measurement => el instanceof Measurement);
  }

  // Changes the selected measurements and updates their captions
  editMeasurements(change: (m: Measurement) => void): void {
    this.checkpoint('appearance');
    const list = this.selectedMeasurements;
    list.forEach(change);
    list.forEach(m => this.updateCaption(m));
    this.touch();
  }

  // Color: on a measurement it recolors its item (tree, estimate and every measurement of it)
  get selectionColor(): string {
    const first = this.selection[0];
    if (!first) return COLORS.gray;
    return first instanceof Measurement ? first.lineColor : first.color ?? COLORS.gray;
  }
  set selectionColor(value: string) {
    this.checkpoint('color');
    const itemIds = new Set(this.selection.map(el => this.itemFor(el)?.id).filter((id): id is string => !!id));
    for (const id of itemIds) {
      const item = this.items.find(i => i.id === id);
      if (item) item.color = value;
      this.measurements.filter(m => m.itemId === id).forEach(m => m.lineColor = value);
    }
    this.selection.forEach(el => {
      if (el instanceof Measurement) el.lineColor = value;
      else { el.color = value; el.dirty = true; }
    });
    this.touch();
  }

  // Fill color: areas (app and PDF polygons) and PDF shapes that have a fill (/IC)
  get selectionHasFill(): boolean {
    return this.selection.some(el => el instanceof Measurement ? el.kind === 'area' : el.fillColor !== null);
  }

  get selectionFillColor(): string {
    const el = this.selection.find(el => el instanceof Measurement ? el.kind === 'area' : el.fillColor !== null);
    if (!el) return COLORS.gray;
    return el instanceof Measurement ? el.areaFillColor : el.fillColor ?? COLORS.gray;
  }
  set selectionFillColor(value: string) {
    this.checkpoint('fill');
    // On a measurement it changes the fill of its item (and of every area of that item)
    const itemIds = new Set(this.selectedMeasurements.filter(m => m.kind === 'area').map(m => m.itemId));
    for (const id of itemIds) {
      const item = this.items.find(i => i.id === id);
      if (item) item.fillColor = value;
      this.measurements.filter(m => m.itemId === id).forEach(m => m.fillColor = value);
    }
    this.selection.forEach(el => {
      if (el instanceof Markup && el.fillColor !== null) { el.fillColor = value; el.dirty = true; }
    });
    this.touch();
  }

  get selectionLineWidth(): number {
    const first = this.selection[0];
    return first ? first.lineWidth : 1;
  }
  set selectionLineWidth(value: number) {
    this.checkpoint('width');
    this.selection.forEach(el => {
      el.lineWidth = value;
      if (el instanceof Markup) el.dirty = true;
    });
    this.touch();
  }

  get measureOpacity(): number { return this.selectedMeasurements[0]?.opacity ?? 1; }
  set measureOpacity(v: number) { this.editMeasurements(m => m.opacity = v); }

  get measureFillOpacity(): number { return this.selectedMeasurements[0]?.fillOpacity ?? 0.2; }
  set measureFillOpacity(v: number) { this.editMeasurements(m => m.fillOpacity = v); }

  get measureLineStyle(): LineStyle { return this.selectedMeasurements[0]?.lineStyle ?? 'Solid'; }
  set measureLineStyle(v: LineStyle) { this.editMeasurements(m => m.lineStyle = v); }

  // Unit of the caption: lengths and areas separately; new measurements use the last one chosen
  get measureLengthUnit(): LengthUnit {
    return this.selectedMeasurements.find(m => m.kind !== 'area' && m.kind !== 'count')?.lengthUnit ?? this.defaultLengthUnit;
  }
  set measureLengthUnit(v: LengthUnit) {
    this.defaultLengthUnit = v;
    this.editMeasurements(m => { if (m.kind !== 'area' && m.kind !== 'count') m.lengthUnit = v; });
  }
  get measureAreaUnit(): LengthUnit {
    const u = this.selectedMeasurements.find(m => m.kind === 'area')?.lengthUnit ?? this.defaultAreaUnit;
    return u === 'ft\' in"' ? 'ft' : u;
  }
  set measureAreaUnit(v: LengthUnit) {
    this.defaultAreaUnit = v;
    this.editMeasurements(m => { if (m.kind === 'area') m.lengthUnit = v; });
  }

  // Units panel: unit of every length and every area caption in the drawing (one Undo step)
  applyUnitsToAll(lengthUnit: LengthUnit, areaUnit: LengthUnit): void {
    this.defaultLengthUnit = lengthUnit;
    this.defaultAreaUnit = areaUnit;
    const target = (m: Measurement) => m.kind === 'area' ? this.defaultAreaUnit : lengthUnit;
    const list = this.measurements.filter(m => m.kind !== 'count' && m.lengthUnit !== target(m));
    if (list.length) {
      this.checkpoint();
      list.forEach(m => { m.lengthUnit = target(m); this.updateCaption(m); });
    }
    this.touch();
    this.showToast(list.length ? `Units changed on ${list.length} measurement${list.length === 1 ? '' : 's'}` : 'Units saved for new measurements');
  }

  get measureArrows(): boolean { return this.selectedMeasurements[0]?.arrowEnds ?? false; }
  set measureArrows(v: boolean) { this.editMeasurements(m => m.arrowEnds = v); }

  // MARK: - Caption (measurement text on the plan)
  get captionVisible(): boolean { return this.selectedMeasurements[0]?.showCaption ?? false; }
  set captionVisible(v: boolean) { this.editMeasurements(m => m.showCaption = v); }

  get captionFontName(): string { return this.selectedMeasurements[0]?.captionFontName ?? 'System'; }
  set captionFontName(v: string) { this.editMeasurements(m => m.captionFontName = v); }

  get captionFontSize(): number { return this.selectedMeasurements[0]?.captionFontSize ?? 12; }
  set captionFontSize(v: number) { this.editMeasurements(m => m.captionFontSize = v); }

  get captionColor(): string { return this.selectedMeasurements[0]?.captionTextColor ?? COLORS.black; }
  set captionColor(v: string) { this.editMeasurements(m => m.captionColor = v); }

  // "Use line": the text takes the color of the line
  get captionUsesLineColor(): boolean { return this.selectedMeasurements[0]?.captionColor === null; }
  set captionUsesLineColor(v: boolean) { this.editMeasurements(m => m.captionColor = v ? null : m.lineColor); }

  get captionBold(): boolean { return this.selectedMeasurements[0]?.captionBold ?? false; }
  set captionBold(v: boolean) { this.editMeasurements(m => m.captionBold = v); }

  get captionItalic(): boolean { return this.selectedMeasurements[0]?.captionItalic ?? false; }
  set captionItalic(v: boolean) { this.editMeasurements(m => m.captionItalic = v); }

  // Big number at the top of Properties: total of the selected measurements
  // ("125.40 ft"), or null when nothing measured is selected or the types are mixed
  get takeoffValueText(): string | null {
    const list = this.selectedMeasurements;
    if (list.length === 0) return null;
    if (new Set(list.map(m => kindUnit(m.kind))).size !== 1) return null;
    const total = list.reduce((sum, m) => sum + this.measuredValue(m), 0);
    return quantityText(total, list[0].kind, list[0].lengthUnit);
  }

  // MARK: - App measurements
  // Esc: finishes the measurement in progress and leaves the tool
  cancelTool(): void {
    this.select(null);
  }

  select(itemId: string | null): void {
    this.finishCurrentMeasurement();
    this.continuingTemplate = null;
    this.continuedGroupName = null;
    this.drawingViewport = false;
    if (itemId) this.snapshotMode = 'none';
    // Lengths and areas need a scale: without one, ask for it first
    const item = itemId ? this.items.find(i => i.id === itemId) : undefined;
    if (item && item.kind !== 'count' && this.hasDocument && !this.hasScale(this.currentPageIndex)) {
      this.selectedItemId = null;
      this.scaleRequest = { id: uid(), target: { type: 'page', pageIndex: this.currentPageIndex }, pendingItemId: item.id };
      this.touch();
      return;
    }
    this.selectedItemId = itemId;
    this.touch();
  }

  // Green dot on a PDF group (for example, Revu markups):
  // a Revu line continues as a line, an area as an area and a count as a count,
  // using the group's name and color. Anything else (stamps, highlights...) is copied per click.
  continueGroup(markups: Markup[]): void {
    const template = markups[markups.length - 1];
    if (!template) return;
    const kind = DrawingStore.takeoffKind(template);
    if (!kind) {
      this.select(null);
      this.continuingTemplate = template;
      this.touch();
      return;
    }
    const name = template.name;
    const item = this.items.find(i => i.name === name && i.kind === kind);
    if (item) this.select(item.id);
    else {
      this.addItem(name, kind, template.color ?? COLORS.blue);
      const added = this.items[this.items.length - 1];
      if (kind === 'area' && template.fillColor) added.fillColor = template.fillColor;
    }
    this.continuedGroupName = name;
    this.touch();
  }

  isContinuing(markups: Markup[]): boolean {
    if (this.continuingTemplate) return markups.includes(this.continuingTemplate);
    if (!this.continuedGroupName || !this.selectedItemId) return false;
    return markups[0]?.name === this.continuedGroupName;
  }

  // Measurement type of a PDF markup: Revu writes it in /IT (PolygonCount, PolyLineDimension...)
  static takeoffKind(m: Markup): TakeoffKind | null {
    if (m.intent.toLowerCase().includes('count')) return 'count';
    switch (m.subtype.toLowerCase()) {
      case 'polyline': case 'line': return 'length';
      case 'polygon': return 'area';
      default: return null;
    }
  }

  // MARK: - Renaming (tree and properties panel share the same name)
  // The item name is the source of truth: it is copied to the Subject of all its measurements
  renameItem(itemId: string, name: string): void {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return;
    this.checkpoint('name');
    // Its estimate group, properties and parts follow the new name
    if (!this.items.some(i => i !== item && i.name === item.name)) this.renameEstimateKey(item.name, name, true);
    item.name = name;
    this.measurements.filter(m => m.itemId === itemId).forEach(m => m.name = name);
    this.touch();
  }

  // Group of PDF markups (Revu or others): changes the Subject of all of them
  renameMarkups(markups: Markup[], name: string): void {
    this.checkpoint('name');
    const old = markups[0]?.name;
    if (old !== undefined && old !== name) this.renameEstimateKey(old, name, true);
    markups.forEach(m => m.name = name);
    this.touch();
  }

  // Measurements of an item on a page (to select them from the tree)
  measurementsOf(itemId: string, pageIndex: number): Measurement[] {
    return this.measurements.filter(m => m.itemId === itemId && m.pageIndex === pageIndex);
  }

  addItem(name: string, kind: TakeoffKind, color: string): void {
    const item: TakeoffItem = { id: uid(), name, kind, color, isVisible: true };
    this.items.push(item);
    this.select(item.id);
  }

  // Points in progress for the live layer: the current measurement or this session's counts
  get livePoints(): LivePoints | null {
    if (this.current) return { pageIndex: this.current.pageIndex, points: this.current.points };
    const last = this.countSession[this.countSession.length - 1];
    if (last) {
      return {
        pageIndex: last.pageIndex,
        points: this.countSession.filter(m => m.pageIndex === last.pageIndex).flatMap(m => m.points),
      };
    }
    return null;
  }

  // Kind and color of the tool in use (null = not measuring with an item)
  get liveKind(): { kind: TakeoffKind; color: string } | null {
    const item = this.selectedItem;
    return item && !this.continuingTemplate ? { kind: item.kind, color: item.color } : null;
  }

  // Name and quantity text Revu shows (written into the PDF when saving)
  private updateCaption(m: Measurement): void {
    const item = this.items.find(i => i.id === m.itemId);
    if (!item) return;
    m.name = item.name;
    m.contents = item.kind === 'count'
      ? '1'
      : quantityText(this.measuredValue(m, item.kind), item.kind, m.lengthUnit);
  }

  // Scale in the format Revu shows: architectural "0.25 in = 1 ft" (1/4" = 1'-0"),
  // engineering and metric "1 in = 10 ft"
  private revuScaleText(denominator: number | null): string {
    if (denominator === null) return '1 in = 1 in';
    const text = (v: number) => v === Math.round(v) ? v.toFixed(0) : String(Number(v.toPrecision(4)));
    if (isArchitecturalScale(denominator)) return `${text(12 / denominator)} in = 1 ft`;
    return `1 in = ${text(denominator / 12)} ft`;
  }

  // MARK: - Saving the PDF (with Bluebeam markups)
  // Save: overwrites the file that was opened, with no dialog.
  // Only when the browser gave no file handle (opened by an old browser or by a drop without a handle)
  // the first Save asks where to save; from then on Save writes to that file.
  async save(): Promise<void> {
    if (!this.lib) return;
    this.finishCurrentMeasurement();
    const handle = this.fileHandle;
    if (!handle || !('createWritable' in handle)) {
      // The browser gave no link to the file (dropped from an app that has no file handle, or opened
      // in a browser without the File System Access API): ask once, then Save writes to that file
      this.showToast(`${this.fileName} was opened without a link to the file. Choose where to save it once.`, true);
      return this.saveAs();
    }
    if (!(await ensureWritePermission(handle))) {
      this.showToast(`No permission to write ${this.fileName}`, true);
      return;
    }
    try {
      const bytes = await this.write();
      const writable = await handle.createWritable();
      await writable.write(bytes as BlobPart);
      await writable.close();
      this.showToast(`Saved ${this.fileName}`);
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't save ${this.fileName}`, true);
    }
  }

  // Save As: saves a copy with another name; from then on Save writes to the copy
  async saveAs(): Promise<void> {
    if (!this.lib) return;
    this.finishCurrentMeasurement();
    const suggested = this.fileName || 'Takeoff.pdf';
    const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker;
    if (!picker) {
      // Safari and Firefox: the browser downloads the file
      const bytes = await this.write();
      downloadFile(new Blob([bytes as BlobPart], { type: 'application/pdf' }), suggested);
      this.showToast(`Downloaded ${suggested}`);
      return;
    }
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: suggested,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch {
      return;                                                   // cancelled
    }
    try {
      const bytes = await this.write();
      const writable = await handle.createWritable();
      await writable.write(bytes as BlobPart);
      await writable.close();
      this.fileHandle = handle;
      this.fileName = handle.name;
      this.showToast(`Saved ${handle.name}`);
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't save ${handle.name}`, true);
    }
  }

  // Writes the PDF with the measurements as Revu markups, the page scales and the viewports
  private async write(): Promise<Uint8Array> {
    const lib = this.lib!;
    this.measurements.forEach(m => this.updateCaption(m));
    // New snapshots: where the picture goes, so it stays upright on rotated pages
    for (const m of this.markups) {
      if (m.ref || !(m.imageJpeg || m.imagePixels) || !this.pages[m.pageIndex]) continue;
      m.imageMatrix = this.imageMatrix(m.rect, this.pages[m.pageIndex]);
    }
    const bytes = await writePdf(lib, {
      measurements: this.measurements.map(m => {
        const first = m.points[0];
        return {
          m,
          feetPerPoint: this.feetPerPoint(m.pageIndex, first),
          scaleText: this.revuScaleText(this.denominator(m.pageIndex, first)),
        };
      }),
      markups: this.markups.filter(m => m.dirty),
      removed: this.removed,
      viewports: this.pages.map((page, i) => {
        const list = [];
        const d = this.pageScales.get(i);
        if (d !== undefined) {
          const media = this.lib!.getPage(i).getMediaBox();
          list.push({ name: 'Page Scale', bbox: { x: media.x, y: media.y, w: media.width, h: media.height },
            feetPerPoint: d / 864, text: this.revuScaleText(d) });
        }
        for (const v of this.viewports.filter(v => v.pageIndex === i)) {
          list.push({ name: v.name, bbox: v.rect, feetPerPoint: v.denominator / 864, text: this.revuScaleText(v.denominator) });
        }
        return list;
      }),
      author: 'CadrafterPro',
      appData: JSON.stringify(this.estimate),
      // Page names (renamed, Create Page Labels) and the order of the pages go into /PageLabels
      pageLabels: this.pagesChanged || this.pageNames.size
        ? this.pages.map((_, i) => this.labelToSave(i)) : undefined,
    });
    this.removed = [];
    return bytes;
  }

  // Live text next to the cursor: "12.50 ft", "340.00 sf", "7 ea" (with the scale at that spot)
  // Count: the next number of the item on this page (keeps counting from what is already there)
  liveCountText(pageIndex: number): string {
    const id = this.selectedItemId;
    const done = id ? this.measurementsOf(id, pageIndex).length : this.countSession.length;
    return `${done + 1} ea`;
  }

  liveText(points: Pt[], kind: TakeoffKind, pageIndex: number): string {
    return quantityText(this.value(points, kind, pageIndex), kind, this.unitFor(kind));
  }

  // MARK: - Snap points of a page (read once, in the background)
  snapIndex(pageIndex: number): SnapIndex | null {
    const cached = this.snapIndexes.get(pageIndex);
    if (cached instanceof SnapIndex) return cached;
    if (!cached && this.pages[pageIndex]) {
      this.snapIndexes.set(pageIndex, 'loading');
      SnapIndex.build(this.pages[pageIndex].page)
        .then(index => this.snapIndexes.set(pageIndex, index))
        .catch(() => this.snapIndexes.delete(pageIndex));
    }
    return null;
  }

  // MARK: - Clicks on the plan
  addPoint(point: Pt, pageIndex: number): void {
    const template = this.continuingTemplate;
    if (template) {
      this.checkpoint();
      // Copies the template markup and centers it on the click
      const copy = template.copy(point);
      copy.pageIndex = pageIndex;
      this.markups.push(copy);
      this.continuingTemplate = copy;                 // the new one is still part of the same group
      this.touch();
      return;
    }
    const item = this.selectedItem;
    if (!item || !this.hasDocument) return;
    // Lengths and areas can't be measured on a page without a scale
    if (item.kind !== 'count' && !this.hasScale(pageIndex)) {
      this.finishCurrentMeasurement();
      this.selectedItemId = null;
      this.scaleRequest = { id: uid(), target: { type: 'page', pageIndex }, pendingItemId: item.id };
      this.touch();
      return;
    }
    this.checkpoint();                                // Ctrl+Z removes this point
    // Count: every click is its own markup (that's how Revu stores it)
    if (item.kind === 'count' || !this.current || this.current.pageIndex !== pageIndex) {
      // A measurement left open on another page is finished (or deleted if incomplete)
      if (this.current) this.finishCurrentMeasurement();
      const m = new Measurement(item.kind, pageIndex, item.id);
      m.lineColor = item.color;
      m.fillColor = item.fillColor ?? null;
      m.lengthUnit = this.unitFor(item.kind);
      m.arrowEnds = item.name === 'Dimension';       // Dimension: arrows on both ends
      m.visible = item.isVisible;
      this.applyLastStyle(m, item);
      this.measurements.push(m);
      this.current = m;
    }
    const m = this.current!;
    m.points = [...m.points, point];
    this.updateCaption(m);
    // Count: kept in the session for the live layer
    if (item.kind === 'count') {
      this.countSession.push(m);
      this.current = null;
    }
    // Segment: every two clicks is a separate line
    if (item.kind === 'segment' && m.points.length === 2) this.current = null;
    this.touch();
  }

  // Continuing an element keeps its look: the style of its last measurement (the last one
  // configured), or of its last PDF markup (a Revu line or area continued from the tree)
  private applyLastStyle(m: Measurement, item: TakeoffItem): void {
    const last = [...this.measurements].reverse().find(x => x.itemId === item.id && x.kind === m.kind);
    if (last) {
      m.lineColor = last.lineColor;
      m.opacity = last.opacity;
      m.fillOpacity = last.fillOpacity;
      m.fillColor = last.fillColor;
      m.lineWidth = last.lineWidth;
      m.lineStyle = last.lineStyle;
      m.showCaption = last.showCaption;
      m.captionFontName = last.captionFontName;
      m.captionFontSize = last.captionFontSize;
      m.captionColor = last.captionColor;
      m.captionBold = last.captionBold;
      m.captionItalic = last.captionItalic;
      m.lengthUnit = last.lengthUnit;
      m.arrowEnds = last.arrowEnds;
      return;
    }
    const markup = [...this.markups].reverse().find(x => x.name === item.name && DrawingStore.takeoffKind(x) === (m.kind === 'segment' ? 'length' : m.kind));
    if (!markup) return;
    if (markup.color) m.lineColor = markup.color;
    m.opacity = markup.opacity;
    if (markup.fillColor) m.fillColor = markup.fillColor;
    if (markup.fillOpacity !== null) m.fillOpacity = markup.fillOpacity;
    if (markup.lineWidth > 0) m.lineWidth = markup.lineWidth;
    m.lineStyle = markup.dashed ? 'Dashed' : 'Solid';
  }

  // MARK: - Top bar (Area, Linear, Segment, Count, Dimension)
  takeoffItems(kind: TakeoffKind): TakeoffItem[] {
    return this.items.filter(i => i.kind === kind && i.name !== 'Dimension');
  }

  // Large button: always a new element (the arrow menu or the tree's green dot continue an existing one)
  startTakeoff(kind: TakeoffKind): void {
    this.newTakeoff(kind);
  }

  // "Area 2", "Count 3"… with the next color of the palette. The number skips every name in use,
  // including PDF markups, so a new element never joins an old one by accident.
  newTakeoff(kind: TakeoffKind): void {
    const used = new Set([...this.items.map(i => i.name), ...this.markups.map(m => m.name)]);
    let number = this.takeoffItems(kind).length + 1;
    while (used.has(`${kindTitle(kind)} ${number}`)) number++;
    this.addItem(`${kindTitle(kind)} ${number}`, kind, PALETTE[this.items.length % PALETTE.length]);
  }

  // PDF markups with the same name as an item on a page: in the tree they are the same element
  itemMarkups(item: TakeoffItem, pageIndex: number): Markup[] {
    return this.markupGroups(pageIndex).find(g => g.name === item.name)?.markups ?? [];
  }

  // Quantity of an item on a page plus its markups already saved in the PDF (ea, ft or sf)
  elementQuantity(item: TakeoffItem, pageIndex: number): number {
    let total = this.quantity(item, pageIndex);
    const markups = this.itemMarkups(item, pageIndex);
    if (markups.length) {
      const [value, unit] = markupQuantity(markups);
      if (item.kind === 'count') total += unit === 'ea' ? value : markups.length;
      else if (unit !== 'ea') total += value;
    }
    return total;
  }

  // Dimension: quick distance (two clicks) without creating another item
  startDimension(): void {
    const item = this.items.find(i => i.name === 'Dimension');
    if (item) this.select(item.id); else this.addItem('Dimension', 'segment', COLORS.blue);
  }

  finishCurrentMeasurement(): void {
    const m = this.current;
    if (m) {
      if (this.isComplete(m)) this.updateCaption(m);
      else this.measurements = this.measurements.filter(x => x !== m);   // a 1-point area is useless in Revu
    }
    this.current = null;
    this.countSession = [];
    this.touch();
  }

  // Area needs 3 points; Linear and Segment need 2; Count needs 1
  private isComplete(m: Measurement): boolean {
    switch (m.kind) {
      case 'count': return m.points.length > 0;
      case 'length': case 'segment': return m.points.length >= 2;
      case 'area': return m.points.length >= 3;
    }
  }

  // Show / hide every measurement of an item
  toggleVisibility(itemId: string): void {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return;
    this.checkpoint();
    item.isVisible = !item.isVisible;
    this.measurements.filter(m => m.itemId === itemId).forEach(m => m.visible = item.isVisible);
    this.touch();
  }

  // Takeoff items with something measured on that page
  itemsOnPage(pageIndex: number): TakeoffItem[] {
    return this.items.filter(item => this.measurements.some(m => m.itemId === item.id && m.pageIndex === pageIndex));
  }

  // Quantity of an item on a page (ea, ft or sf)
  quantity(item: TakeoffItem, pageIndex: number): number {
    return this.measurements
      .filter(m => m.itemId === item.id && m.pageIndex === pageIndex)
      .reduce((sum, m) => sum + this.measuredValue(m, item.kind), 0);
  }

  // Quantity of one measurement: an area without its cut outs
  measuredValue(m: Measurement, kind: TakeoffKind = m.kind): number {
    if (kind !== 'area' || !m.cutouts.length) return this.value(m.points, kind, m.pageIndex);
    const scale = this.feetPerPoint(m.pageIndex, m.points[0]);
    return netPolygonArea(m.points, m.cutouts) * scale * scale;
  }

  // MARK: - Cut Out (holes in areas)
  // The area a hole drawn on the page belongs to: an area measurement (the app's own or a Revu
  // area from the PDF) around the hole's points. The selected one wins, then the smallest.
  cutoutTarget(pageIndex: number, hole: Pt[]): Measurement | Markup | null {
    const inside = (poly: Pt[]) => hole.every(p => pointInPolygon(p, poly));
    const candidates: { el: Measurement | Markup; outline: Pt[] }[] = [];
    for (const el of this.elementsOn(pageIndex)) {
      if (!el.visible) continue;
      if (el instanceof Measurement) {
        if (el.kind === 'area' && el.points.length >= 3 && inside(el.points)) candidates.push({ el, outline: el.points });
      } else if (isRevuArea(el) && inside(el.vertices!)) {
        candidates.push({ el, outline: el.vertices! });
      }
    }
    if (!candidates.length) return null;
    const selected = candidates.find(c => this.selection.includes(c.el));
    if (selected) return selected.el;
    candidates.sort((a, b) => polygonArea(a.outline) - polygonArea(b.outline));
    return candidates[0].el;
  }

  // Cuts the hole out of the area under it; false when there is no area there
  addCutout(pageIndex: number, hole: Pt[]): boolean {
    if (hole.length < 3 || polygonArea(hole) <= 0) return false;
    const target = this.cutoutTarget(pageIndex, hole);
    if (!target) return false;
    this.checkpoint();
    this.setCutouts(target, [...target.cutouts, hole.map(p => ({ ...p }))]);
    this.selectElements([target]);
    this.touch();
    return true;
  }

  // Selected areas with holes (for "Remove Cut Outs")
  get selectionHasCutouts(): boolean {
    return this.selection.some(el => (el instanceof Measurement || el instanceof Markup) && el.cutouts.length > 0);
  }

  removeCutouts(): void {
    const list = this.selection.filter((el): el is Measurement | Markup =>
      (el instanceof Measurement || el instanceof Markup) && el.cutouts.length > 0);
    if (!list.length) return;
    this.checkpoint();
    list.forEach(el => this.setCutouts(el, []));
    this.touch();
  }

  private setCutouts(el: Measurement | Markup, holes: Pt[][]): void {
    if (el instanceof Measurement) {
      el.cutouts = holes;
      this.updateCaption(el);
      return;
    }
    // Revu area: its /Contents ("154.09 sf") follows the share of the outline that is left
    const outline = el.vertices ?? [];
    const before = netPolygonArea(outline, el.cutouts);
    const after = netPolygonArea(outline, holes);
    el.cutouts = holes;
    el.redrawAppearance = true;
    el.dirty = true;
    if (before > 0) el.contents = scaleQuantityText(el.contents, after / before);
  }

  // Quantity in ft / sf, with the scale where the measurement starts (viewport or page)
  value(p: Pt[], kind: TakeoffKind, pageIndex: number): number {
    const scale = this.feetPerPoint(pageIndex, p[0]);
    switch (kind) {
      case 'count': return p.length;
      case 'length': case 'segment': return polylineLength(p) * scale;
      case 'area': return polygonArea(p) * scale * scale;
    }
  }

  // MARK: - Pages (Pages panel: add, delete, move, insert from another PDF)
  // Every change rebuilds the page list from "slots": an existing page (old index) or a new page.
  // pdf-lib gets the same order, and everything that remembers a page index follows its page.
  insertRequest: InsertRequest | null = null;     // "Insert Pages" dialog on screen

  // Blank page with the size of the page next to it
  async insertBlankPage(at: number): Promise<void> {
    const lib = this.lib;
    if (!lib) return;
    const near = lib.getPage(Math.min(Math.max(at - 1, 0), this.pageCount - 1));
    const { width, height } = near.getSize();
    const page = PDFPage.create(lib);
    page.setSize(width, height);
    page.setRotation(near.getRotation());
    // pdf.js needs its own copy of an empty page to draw it
    const blank = await PDFDocument.create();
    blank.addPage([width, height]).setRotation(near.getRotation());
    const renderer = await openRenderer(await blank.save());
    this.extraRenderers.push(renderer);
    const geometry = new PageGeometry(await renderer.getPage(1));
    const slots: PageSlot[] = this.pages.map((_, i) => ({ old: i }));
    slots.splice(at, 0, { page, geometry, label: '' });
    this.rebuildPages(slots);
    this.goTo(at);
    this.showToast(`Blank page added (${this.pageName(at)})`);
  }

  // A PDF was picked (or dropped on the Pages panel): ask which pages and where
  async requestInsertPages(bytes: Uint8Array, name: string, at = this.currentPageIndex + 1): Promise<void> {
    if (!this.lib) return;
    try {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      this.insertRequest = { id: uid(), name, bytes, pageCount: source.getPageCount(), at };
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't read ${name}`, true);
    }
    this.touch();
  }

  cancelInsertPages(): void {
    this.insertRequest = null;
    this.touch();
  }

  // Insert in the dialog: copies those pages (with their markups and scales) at `at`
  async insertPages(pageNumbers: number[], at: number): Promise<void> {
    const request = this.insertRequest;
    const lib = this.lib;
    this.insertRequest = null;
    if (!request || !lib || pageNumbers.length === 0) return this.touch();
    try {
      const source = await PDFDocument.load(request.bytes, { ignoreEncryption: true, updateMetadata: false });
      const indexes = pageNumbers.map(n => n - 1);
      const copies = await lib.copyPages(source, indexes);
      const renderer = await openRenderer(request.bytes);
      this.extraRenderers.push(renderer);
      const labels = await renderer.getPageLabels().catch(() => null);
      const geometries = await Promise.all(indexes.map(i => renderer.getPage(i + 1).then(p => new PageGeometry(p))));
      const slots: PageSlot[] = this.pages.map((_, i) => ({ old: i }));
      const position = Math.min(Math.max(at, 0), this.pageCount);
      slots.splice(position, 0, ...copies.map((page, k) => {
        const label = labels?.[indexes[k]] ?? '';
        return { page, geometry: geometries[k], label: label === String(indexes[k] + 1) ? '' : label };
      }));
      this.rebuildPages(slots);
      // Markups and scales that came with the new pages
      for (let k = 0; k < copies.length; k++) {
        const data = readPage(copies[k], position + k);
        this.markups.push(...data.markups);
        if (data.scale !== null) this.pageScales.set(position + k, data.scale);
        this.viewports.push(...data.viewports);
      }
      this.goTo(position);
      this.showToast(`${copies.length} page${copies.length === 1 ? '' : 's'} inserted from ${request.name}`);
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't insert pages from ${request.name}`, true);
    }
  }

  // MARK: - Rotate and sort pages (Page tab)
  // Services that keep something per page object (OCR) follow a page that gets a new geometry
  private readonly pageSwapListeners: ((old: PageGeometry, next: PageGeometry) => void)[] = [];
  onPageSwap(listener: (old: PageGeometry, next: PageGeometry) => void): void {
    this.pageSwapListeners.push(listener);
  }

  // Turns pages by `degrees` (90 = right, -90 = left, 180). Markups and measurements stay on
  // the drawing: they are kept in page coordinates, only the view turns.
  rotatePages(indexes: number[], degrees: number): void {
    const lib = this.lib;
    const list = [...new Set(indexes)].filter(i => i >= 0 && i < this.pageCount);
    if (!lib || list.length === 0 || degrees % 360 === 0) return;
    this.finishCurrentMeasurement();
    for (const i of list) {
      const old = this.pages[i];
      const next = new PageGeometry(old.page, old.rotation + degrees);
      lib.getPage(i).setRotation(pdfDegrees(next.rotation));
      this.pages[i] = next;
      this.pageSwapListeners.forEach(listener => listener(old, next));
    }
    this.pages = [...this.pages];
    this.pagesChanged = true;
    const turn = degrees === 180 || degrees === -180 ? '180°' : degrees > 0 ? 'right' : 'left';
    this.showToast(list.length === 1 ? `${this.pageName(list[0])} rotated ${turn}` : `${list.length} pages rotated ${turn}`);
    this.touch();
  }

  // MARK: - Extract Pages: the chosen pages (with markups and measurements) into a new PDF
  extractOpen = false;
  openExtract(): void { if (this.hasDocument) { this.extractOpen = true; this.touch(); } }
  closeExtract(): void { this.extractOpen = false; this.touch(); }

  // false when nothing was saved (cancelled)
  async extractPages(indexes: number[], separate: boolean, deleteAfter: boolean): Promise<boolean> {
    if (!this.lib || !indexes.length) return false;
    this.finishCurrentMeasurement();
    const pages = [...indexes].sort((a, b) => a - b);
    const base = (this.fileName || 'Document').replace(/\.pdf$/i, '');
    const safe = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Page';
    // Groups of pages, one PDF each
    const groups = separate ? pages.map(i => [i]) : [pages];
    const fileNames = groups.map(g => g.length === 1 ? `${base} - ${safe(this.pageName(g[0]))}.pdf` : `${base} - Extracted.pdf`);
    const unique = fileNames.map((n, i) => fileNames.indexOf(n) === i ? n : n.replace(/\.pdf$/, ` (${pages[i] + 1}).pdf`));

    // Where to save: one file → Save As window; several → a folder (or downloads)
    type Picker = (o: object) => Promise<FileSystemFileHandle>;
    type DirPicker = (o?: object) => Promise<FileSystemDirectoryHandle>;
    const w = window as unknown as { showSaveFilePicker?: Picker; showDirectoryPicker?: DirPicker };
    let fileHandle: FileSystemFileHandle | null = null;
    let folder: FileSystemDirectoryHandle | null = null;
    try {
      if (groups.length === 1 && w.showSaveFilePicker) {
        fileHandle = await w.showSaveFilePicker({ suggestedName: unique[0], types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      } else if (groups.length > 1 && w.showDirectoryPicker) {
        folder = await w.showDirectoryPicker({ mode: 'readwrite' });
      }
    } catch {
      return false;                                             // cancelled
    }

    try {
      // The document as it would be saved (measurements written as Revu markups), then its pages copied
      const source = await PDFDocument.load(await this.write(), { ignoreEncryption: true });
      for (const [k, group] of groups.entries()) {
        const out = await PDFDocument.create();
        const copied = await out.copyPages(source, group);
        copied.forEach(p => out.addPage(p));
        // Page names go along as page labels (Revu and CadrafterPro show them as the page names)
        const nums: unknown[] = [];
        group.forEach((index, i) => nums.push(i, { P: PDFHexString.fromText(this.pageName(index)) }));
        out.catalog.set(PDFName.of('PageLabels'), out.context.obj({ Nums: nums } as never));
        const bytes = await out.save({ useObjectStreams: false });
        if (fileHandle) {
          const writable = await fileHandle.createWritable();
          await writable.write(bytes as BlobPart);
          await writable.close();
        } else if (folder) {
          const handle = await folder.getFileHandle(unique[k], { create: true });
          const writable = await handle.createWritable();
          await writable.write(bytes as BlobPart);
          await writable.close();
        } else {
          downloadFile(new Blob([bytes as BlobPart], { type: 'application/pdf' }), unique[k]);
        }
      }
    } catch (error) {
      console.error(error);
      this.showToast("Couldn't extract the pages", true);
      return false;
    }
    const what = groups.length === 1 ? (fileHandle?.name ?? unique[0]) : `${groups.length} files`;
    if (deleteAfter && pages.length < this.pageCount) this.deletePages(pages);
    this.showToast(`Extracted ${pages.length} page${pages.length === 1 ? '' : 's'} to ${what}`);
    return true;
  }

  batchRotateOpen = false;                         // Batch Rotate Pages window on screen
  openBatchRotate(): void { if (this.hasDocument) { this.batchRotateOpen = true; this.touch(); } }
  closeBatchRotate(): void { this.batchRotateOpen = false; this.touch(); }

  // Orders the pages by name, numbers in names counted as numbers ("A-2" before "A-10")
  sortPagesByName(): void {
    const names = this.pages.map((_, i) => this.pageName(i));
    const order = names.map((_, i) => i)
      .sort((a, b) => names[a].localeCompare(names[b], undefined, { numeric: true, sensitivity: 'base' }));
    if (order.every((old, i) => old === i)) {
      this.showToast('The pages are already in order');
      return;
    }
    this.rebuildPages(order.map(old => ({ old })));
    this.showToast('Pages sorted by name');
  }

  // MARK: - Slip Sheet
  // Replaces the drawing of pages with pages of another PDF (an addendum or a new revision), keeping
  // everything that was on them: markups, measurements, highlights, scales and page names.
  // pairs: page of this document ← page of the other file (0-based). append: pages of the other
  // file added at the end (new sheets), with their name. Page changes can't be undone (like the
  // Pages panel). Returns how many pages were replaced.
  async slipSheet(bytes: Uint8Array, renderer: PDFDocumentProxy, fileName: string,
                  pairs: { target: number; source: number }[], append: { source: number; label: string }[]): Promise<number> {
    const lib = this.lib;
    if (!lib || (pairs.length === 0 && append.length === 0)) return 0;
    try {
      this.finishCurrentMeasurement();
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const sources = [...pairs.map(p => p.source), ...append.map(a => a.source)];
      const copies = await lib.copyPages(source, sources);
      const geometries = await Promise.all(sources.map(i => renderer.getPage(i + 1).then(p => new PageGeometry(p))));
      this.extraRenderers.push(renderer);

      const slots: PageSlot[] = this.pages.map((_, i) => ({ old: i }));
      // Markups that came with the new pages, read before the old annotations move over
      const incoming: { index: number; data: ReturnType<typeof readPage> }[] = [];
      let resized = 0;
      pairs.forEach((pair, k) => {
        const page = copies[k];
        const old = lib.getPage(pair.target);
        incoming.push({ index: pair.target, data: readPage(page, pair.target) });
        // The annotations of the old page (markups, measurements saved before, highlights) go onto
        // the new one, so the saved file keeps them and Undo / Delete still find them
        const annots = old.node.Annots();
        for (let i = 0; i < (annots?.size() ?? 0); i++) {
          const ref = annots!.get(i);
          const dict = annots!.lookupMaybe(i, PDFDict);
          if (dict) dict.set(PDFName.of('P'), page.ref);
          page.node.addAnnot(ref as PDFRef);
        }
        const before = this.pages[pair.target];
        if (before && (Math.abs(before.width - geometries[k].width) > 1 || Math.abs(before.height - geometries[k].height) > 1)) resized++;
        slots[pair.target] = { old: pair.target, page, geometry: geometries[k] };
      });
      append.forEach((a, k) => {
        const page = copies[pairs.length + k];
        incoming.push({ index: slots.length, data: readPage(page, slots.length) });
        slots.push({ page, geometry: geometries[pairs.length + k], label: a.label });
      });
      this.rebuildPages(slots);
      for (const { index, data } of incoming) {
        this.markups.push(...data.markups);
        if (data.scale !== null && !this.pageScales.has(index)) this.pageScales.set(index, data.scale);
        if (!this.viewports.some(v => v.pageIndex === index)) this.viewports.push(...data.viewports);
        this.snapIndexes.delete(index);
      }
      this.pagesChanged = true;
      const parts = [`${pairs.length} page${pairs.length === 1 ? '' : 's'} replaced from ${fileName}`];
      if (append.length) parts.push(`${append.length} new page${append.length === 1 ? '' : 's'} added at the end`);
      if (resized) parts.push(`${resized} with a different size: check the markups`);
      this.showToast(parts.join(', '), resized > 0);
      this.touch();
      return pairs.length;
    } catch (error) {
      console.error(error);
      this.showToast(`Couldn't use the pages of ${fileName}`, true);
      return 0;
    }
  }

  // Deletes pages and everything measured on them (a document keeps at least one page)
  deletePages(indexes: number[]): void {
    const gone = new Set(indexes.filter(i => i >= 0 && i < this.pageCount));
    if (gone.size === 0) return;
    if (gone.size >= this.pageCount) {
      this.showToast('A document needs at least one page', true);
      return;
    }
    this.rebuildPages(this.pages.map((_, i) => ({ old: i })).filter(slot => !gone.has(slot.old)));
    this.showToast(gone.size === 1 ? 'Page deleted' : `${gone.size} pages deleted`);
  }

  // Moves pages so they sit before the page that is now at `before` (pageCount = at the end)
  movePages(indexes: number[], before: number): void {
    const moving = [...new Set(indexes)].filter(i => i >= 0 && i < this.pageCount).sort((a, b) => a - b);
    if (moving.length === 0) return;
    const rest = this.pages.map((_, i) => i).filter(i => !moving.includes(i));
    const position = rest.filter(i => i < before).length;
    const order = [...rest.slice(0, position), ...moving, ...rest.slice(position)];
    if (order.every((old, i) => old === i)) return;
    this.rebuildPages(order.map(old => ({ old })));
  }

  private rebuildPages(slots: PageSlot[]): void {
    const lib = this.lib;
    if (!lib || slots.length === 0) return;
    this.finishCurrentMeasurement();
    this.snapshotMode = 'none';
    const oldPages = lib.getPages();
    const oldGeometry = this.pages;
    const oldLabels = this.pageLabels;
    // Labels that are only the page numbers ("1", "2"…) don't follow the pages
    const numbered = oldLabels.every((l, i) => !l || l === String(i + 1));

    // pdf-lib: take every page out, then put them back in the new order
    for (let i = lib.getPageCount() - 1; i >= 0; i--) lib.removePage(i);
    slots.forEach((slot, i) => lib.insertPage(i, 'old' in slot ? slot.page ?? oldPages[slot.old] : slot.page));

    // Old index → new index (-1 = deleted)
    const newIndex = new Array<number>(oldGeometry.length).fill(-1);
    slots.forEach((slot, i) => { if ('old' in slot) newIndex[slot.old] = i; });
    const map = (i: number) => newIndex[i] ?? -1;

    this.pages = slots.map(slot => 'old' in slot ? slot.geometry ?? oldGeometry[slot.old] : slot.geometry);
    this.pageLabels = slots.map(slot => 'old' in slot ? (numbered ? '' : oldLabels[slot.old] ?? '') : slot.label);
    this.remapPageIndexes(map);
    this.pagesChanged = true;
    this.touch();
  }

  // Everything that keeps a page index follows its page; what was on a deleted page goes away
  private remapPageIndexes(map: (i: number) => number): void {
    const keep = (el: { pageIndex: number }) => map(el.pageIndex) >= 0;
    const move = (el: { pageIndex: number }) => { el.pageIndex = map(el.pageIndex); };
    const remapScales = (scales: Map<number, number>) =>
      new Map([...scales].filter(([i]) => map(i) >= 0).map(([i, d]) => [map(i), d] as [number, number]));
    const remapNames = (names: Map<number, string>) =>
      new Map([...names].filter(([i]) => map(i) >= 0).map(([i, n]) => [map(i), n] as [number, string]));

    this.measurements = this.measurements.filter(keep);
    this.measurements.forEach(move);
    this.markups = this.markups.filter(keep);
    this.markups.forEach(move);
    this.removed = this.removed.filter(keep).map(r => ({ ...r, pageIndex: map(r.pageIndex) }));
    this.viewports = this.viewports.filter(keep).map(v => ({ ...v, pageIndex: map(v.pageIndex) }));
    this.pageScales = remapScales(this.pageScales);
    this.pageNames = remapNames(this.pageNames);
    this.selection = this.selection.filter(el => el.pageIndex >= 0 && (el instanceof Measurement
      ? this.measurements.includes(el) : this.markups.includes(el)));
    if (this.continuingTemplate && !this.markups.includes(this.continuingTemplate)) this.continuingTemplate = null;
    this.countSession = [];

    // Snap points are kept for pages that stay
    const snaps = new Map<number, SnapIndex | 'loading'>();
    for (const [i, index] of this.snapIndexes) if (map(i) >= 0 && index !== 'loading') snaps.set(map(i), index);
    this.snapIndexes = snaps;

    // Panes and their Back / Forward history
    const last = this.pageCount - 1;
    this.pageIndexes = this.pageIndexes.map(i => map(i) >= 0 ? map(i) : Math.min(i, last));
    this.history.forEach(h => {
      h.back = h.back.map(map).filter(i => i >= 0);
      h.forward = h.forward.map(map).filter(i => i >= 0);
    });

    // Overlay
    const o = this.overlay();
    if (o) {
      const base = map(o.baseIndex), source = map(o.sourceIndex);
      this.overlay.set(base >= 0 && source >= 0 ? { ...o, baseIndex: base, sourceIndex: source } : null);
    }

    // Undo / Redo steps: their saved page indexes follow too
    const remapSnapshot = (snap: Snapshot) => {
      const index = (state: Record<string, unknown>) => map(state['pageIndex'] as number);
      snap.measurements = snap.measurements.filter(([, st]) => index(st) >= 0);
      snap.measurements.forEach(([, st]) => st['pageIndex'] = index(st));
      snap.markups = snap.markups.filter(([, st]) => index(st) >= 0);
      snap.markups.forEach(([, st]) => st['pageIndex'] = index(st));
      snap.removed = snap.removed.filter(keep).map(r => ({ ...r, pageIndex: map(r.pageIndex) }));
      snap.viewports = snap.viewports.filter(keep).map(v => ({ ...v, pageIndex: map(v.pageIndex) }));
      snap.pageScales = remapScales(snap.pageScales);
      snap.pageNames = remapNames(snap.pageNames ?? new Map());
      snap.current = null;
      snap.countSession = [];
    };
    this.undoStack.forEach(remapSnapshot);
    this.redoStack.forEach(remapSnapshot);
  }

  private destroyExtraRenderers(): void {
    this.extraRenderers.forEach(r => r.destroy());
    this.extraRenderers = [];
  }

  // MARK: - Snapshot (copy a region of a page, paste it as a picture on any page, like Revu)
  // 'capture': the next drag on the plan copies that region; 'place': the picture follows the cursor
  snapshotMode: 'none' | 'capture' | 'place' = 'none';
  snapshotClip: SnapshotClip | null = null;

  startSnapshot(): void {
    if (!this.hasDocument) return;
    this.select(null);
    this.snapshotMode = 'capture';
    this.showToast('Drag a box around the region to copy');
  }

  // The plan copied the region: keep it for Paste
  setSnapshotClip(clip: SnapshotClip): void {
    this.snapshotClip = clip;
    this.clipboardKind = 'snapshot';
    this.snapshotMode = 'none';
    this.showToast('Snapshot copied. Go to any page and press Paste (Ctrl+V)');
  }

  pasteSnapshot(): void {
    if (!this.hasDocument || !this.snapshotClip) return;
    this.select(null);
    this.snapshotMode = 'place';
    this.touch();
  }

  cancelSnapshot(): void {
    if (this.snapshotMode === 'none') return;
    this.snapshotMode = 'none';
    this.touch();
  }

  // Click on the plan while pasting: the picture becomes an image markup (rect in page coordinates)
  placeSnapshot(pageIndex: number, rect: Rect): void {
    const clip = this.snapshotClip;
    if (!clip) return;
    this.checkpoint();
    const m = new Markup(pageIndex);
    m.subtype = 'Stamp';
    m.subject = 'Snapshot';
    m.rect = rect;
    m.lineWidth = 0;
    m.imageUrl = clip.url;
    m.imageJpeg = clip.jpeg;
    m.dirty = true;
    this.markups.push(m);
    this.snapshotMode = 'none';
    this.selection = [m];
    this.touch();
  }

  // Unit square of the picture → page coordinates: its corners as seen on screen
  private imageMatrix(rect: Rect, g: PageGeometry): number[] {
    const v = g.rectToView(rect);
    const origin = g.toPage({ x: v.x, y: v.y + v.h });       // bottom-left of the picture
    const right = g.toPage({ x: v.x + v.w, y: v.y + v.h });
    const top = g.toPage({ x: v.x, y: v.y });
    return [right.x - origin.x, right.y - origin.y, top.x - origin.x, top.y - origin.y, origin.x, origin.y];
  }

  // MARK: - Overlay (one page over another in another color, to compare revisions)
  readonly overlay = signal<OverlayState | null>(null);

  // Starts with the current page underneath and the next one (or the previous) on top
  startOverlay(): void {
    if (!this.hasDocument || this.pageCount < 2) {
      this.showToast('Overlay needs a document with two or more pages', true);
      return;
    }
    const base = this.currentPageIndex;
    this.overlay.set({
      baseIndex: base, sourceIndex: base + 1 < this.pageCount ? base + 1 : base - 1,
      baseColor: '#FF3B30', overlayColor: '#007AFF', opacity: 0.85,
      dx: 0, dy: 0, scale: 1, rotation: 0, adjusting: false,
    });
    this.touch();
  }

  updateOverlay(change: Partial<OverlayState>): void {
    const o = this.overlay();
    if (!o) return;
    const next = { ...o, ...change };
    // Same page underneath and on top: they trade places
    if (next.baseIndex === next.sourceIndex) {
      next.sourceIndex = change.baseIndex !== undefined ? o.baseIndex : o.sourceIndex;
      if (change.sourceIndex !== undefined) next.baseIndex = o.sourceIndex;
    }
    // A new page on top starts lined up again
    if (change.sourceIndex !== undefined && change.sourceIndex !== o.sourceIndex) {
      Object.assign(next, { dx: 0, dy: 0, scale: 1, rotation: 0 });
    }
    this.overlay.set(next);
    if (change.baseIndex !== undefined && change.baseIndex !== o.baseIndex) this.goTo(change.baseIndex);
  }

  closeOverlay(): void {
    this.overlay.set(null);
    this.touch();
  }

  // Confirm: the page on top stays on the base page as a picture (an "Overlay" item of the document,
  // saved in the PDF as an image markup with transparency). rect = the whole base page.
  confirmOverlay(picture: { url: string; pixels: { width: number; height: number; rgba: Uint8ClampedArray } }): void {
    const o = this.overlay();
    const g = o ? this.pages[o.baseIndex] : null;
    if (!o || !g) return;
    this.checkpoint();
    const m = new Markup(o.baseIndex);
    m.subtype = 'Stamp';
    m.subject = 'Overlay';
    m.contents = `${this.pageName(o.sourceIndex)} over ${this.pageName(o.baseIndex)}`;
    m.rect = g.rectToPage({ x: 0, y: 0, w: g.width, h: g.height });
    m.lineWidth = 0;
    m.imageUrl = picture.url;
    m.imagePixels = picture.pixels;
    m.dirty = true;
    this.markups.push(m);
    this.overlay.set(null);
    this.selection = [m];
    this.goTo(o.baseIndex);
    this.showToast('Overlay added to the page. Save to keep it in the PDF; Undo removes it');
    this.touch();
  }

  // MARK: - Estimate ("Estimating" tab, PlanSwift style)
  // Rows: every element (app takeoff item or PDF markup group, matched by name) and the Parts.
  // Parts hang under their element (sub-items). Nothing is grouped by default: the user makes
  // groups (folders) and drags rows into them. Every row has properties with formulas.
  estimate: EstimateData = emptyEstimate();
  get estimateGroups(): EstimateGroup[] { return this.estimate.groups; }
  set estimateGroups(value: EstimateGroup[]) { this.estimate.groups = value; }
  selectedEstimateKey: string | null = null;      // row selected in the estimate table
  propertiesKey: string | null = null;            // row whose Properties window is open
  columnsOpen = false;                            // Columns window open

  // Measured values of an element and the kind of its takeoff
  elementInfo(name: string): { kind: ElementKind; takeoff: TakeoffValues; color: string; pages: number[] } | null {
    const takeoff: TakeoffValues = { 'Area': 0, 'Linear Total': 0, 'Segment Count': 0, 'Point Count': 0, 'Section Count': 0 };
    const pages = new Set<number>();
    let kind: ElementKind | null = null;
    let color: string = COLORS.gray;
    for (const item of this.items.filter(i => i.name === name)) {
      const list = this.measurements.filter(m => m.itemId === item.id);
      if (list.length === 0) continue;
      kind ??= item.kind === 'area' ? 'area' : item.kind === 'count' ? 'count' : 'length';
      color = item.color;
      for (const m of list) {
        const n = m.points.length;
        const scale = this.feetPerPoint(m.pageIndex, m.points[0]);
        pages.add(m.pageIndex);
        takeoff['Section Count'] += 1;
        takeoff['Point Count'] += n;
        if (m.kind === 'area') {
          takeoff['Area'] += this.measuredValue(m, 'area');
          takeoff['Linear Total'] += polylineLength([...m.points, m.points[0]]) * scale;
          takeoff['Segment Count'] += n;
        } else if (m.kind !== 'count') {
          takeoff['Linear Total'] += this.value(m.points, m.kind, m.pageIndex);
          takeoff['Segment Count'] += Math.max(n - 1, 0);
        }
      }
    }
    // Markups already in the PDF: Revu writes the value in /Contents ("154.09 sf", "52.82 ft")
    const regex = /^\s*([0-9][0-9,]*\.?[0-9]*)\s*([A-Za-z' ]*)\s*$/;
    for (const m of this.markups.filter(m => m.isPlanElement && m.name === name)) {
      pages.add(m.pageIndex);
      if (color === COLORS.gray && m.color) color = m.color;
      takeoff['Section Count'] += 1;
      const match = regex.exec(m.contents);
      const value = match ? Number(match[1].replace(/,/g, '')) : 0;
      const unit = match ? match[2].trim().toLowerCase() : '';
      const vertices = m.vertices?.length ?? 0;
      if (match && (unit === 'sf' || unit === 'sq ft' || unit.includes('m²'))) {
        kind ??= 'area';
        takeoff['Area'] += value;
        takeoff['Segment Count'] += vertices;
        takeoff['Point Count'] += vertices;
      } else if (match && (unit === 'ft' || unit === "'" || unit === 'lf')) {
        kind ??= 'length';
        takeoff['Linear Total'] += value;
        takeoff['Segment Count'] += Math.max(vertices - 1, 0);
        takeoff['Point Count'] += vertices;
      } else {
        kind ??= 'count';
        takeoff['Point Count'] += match ? value : 1;
      }
    }
    return kind ? { kind, takeoff, color, pages: [...pages].sort((a, b) => a - b) } : null;
  }

  // Names of all the elements (app items with measurements, then PDF markup groups)
  private elementNames(): string[] {
    const names: string[] = [];
    for (const item of this.items) {
      if (this.measurements.some(m => m.itemId === item.id) && !names.includes(item.name)) names.push(item.name);
    }
    const markupNames = new Set<string>();
    for (const m of this.markups) if (m.isPlanElement) markupNames.add(m.name);
    for (const name of [...markupNames].sort()) if (!names.includes(name)) names.push(name);
    return names;
  }

  isPart(key: string): boolean {
    return this.estimate.parts.some(p => p.id === key);
  }

  // Properties of a row: a part's own list, or the element's (its template until edited)
  rowProps(key: string): PropertyDef[] {
    const part = this.estimate.parts.find(p => p.id === key);
    if (part) return part.props;
    const markupType = this.markupTypeOf(key);
    const saved = this.estimate.elementProps[key];
    if (saved) {
      // Saved before markups had their own type: "Count" becomes "Highlight", "Cloud"…
      const type = saved.find(p => p.name === 'Type');
      if (type && markupType && type.formula === 'Count') type.formula = markupType;
      return upgradeProps(saved, this.elementInfo(key)?.kind ?? 'count');
    }
    return elementTemplate(this.elementInfo(key)?.kind ?? 'count', key, markupType);
  }

  // Type of the PDF markups named `name` when they are not measurements (null for takeoff elements)
  markupTypeOf(name: string): string | null {
    if (this.items.some(i => i.name === name && this.measurements.some(m => m.itemId === i.id))) return null;
    const list = this.markups.filter(m => m.isPlanElement && m.name === name);
    const types = new Set(list.map(m => m.markupType));
    return types.size === 1 ? [...types][0] : null;
  }

  // What the formulas of a row are calculated from. `props` replaces the row's list
  // (the Properties window shows results while editing).
  evalNode(key: string, props?: PropertyDef[], depth = 0): EvalNode {
    // Parts right below, for [Parts:…] (each one reaches this row again through [..])
    const children = () => depth > 20 ? [] : this.estimate.parts.filter(p => p.parentKey === key)
      .map(p => this.evalNode(p.id, undefined, depth + 1));
    const part = this.estimate.parts.find(p => p.id === key);
    if (part) {
      const parent = part.parentKey && depth < 20 ? this.evalNode(part.parentKey, undefined, depth + 1) : null;
      return { props: props ?? part.props, takeoff: null, parent, children };
    }
    return { props: props ?? this.rowProps(key), takeoff: this.elementInfo(key)?.takeoff ?? null, parent: null, children };
  }

  // MARK: - Slope (Pitch)
  pitchOpen = false;                               // Pitch window on screen
  pitchSeed: number | null = null;                 // pitch measured on the plan, offered in the window

  openPitch(seed: number | null = null): void {
    if (!this.hasDocument) return;
    this.pitchSeed = seed;
    this.pitchOpen = true;
    this.touch();
  }

  closePitch(): void {
    this.pitchOpen = false;
    this.touch();
  }

  // Areas and lines of the estimate (what a pitch applies to)
  slopeElements(): { name: string; kind: ElementKind; pitch: number; hip: boolean; sloped: boolean }[] {
    return this.elementNames()
      .map(name => ({ name, info: this.elementInfo(name) }))
      .filter(e => e.info && e.info.kind !== 'count')
      .map(({ name, info }) => {
        const props = this.rowProps(name);
        const pitch = Number(evaluate({ props, takeoff: null, parent: null }, 'Pitch').value) || 0;
        const factor = findProp(props, 'Slope Factor')?.formula.replace(/\s+/g, '') ?? '';
        const qty = findProp(props, 'Qty')?.formula ?? '';
        return { name, kind: info!.kind, pitch, hip: factor === SLOPE_FACTOR_FORMULAS.hip.replace(/\s+/g, ''), sloped: /\[Sloped /.test(qty) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // The items picked by default: selected on the plan, in the tree or in the estimate
  slopeTargets(): string[] {
    const names = new Set<string>();
    for (const el of this.selection) if (el.name) names.add(el.name);
    if (this.selectedItem) names.add(this.selectedItem.name);
    for (const key of this.estimateSelection) names.add(key);
    const allowed = new Set(this.slopeElements().map(e => e.name));
    return [...names].filter(n => allowed.has(n));
  }

  // Pitch window Ok: rise per 12 of run, roof plane or hip / valley, and whether Qty takes the
  // sloped value (one Undo step)
  applyPitch(names: string[], pitch: number, hip: boolean, useForQty: boolean): void {
    if (names.length === 0) return;
    this.checkpoint();
    for (const name of names) {
      const kind = this.elementInfo(name)?.kind;
      if (!kind || kind === 'count') continue;
      const props = structuredClone(this.rowProps(name));
      upgradeProps(props, kind);
      const set = (prop: string, formula: string) => { const def = findProp(props, prop); if (def) def.formula = formula; };
      set('Pitch', String(Math.round(pitch * 1000) / 1000));
      set('Slope Factor', hip ? SLOPE_FACTOR_FORMULAS.hip : SLOPE_FACTOR_FORMULAS.plane);
      const measured = kind === 'area' ? '[Area]' : '[Linear Total]';
      const sloped = kind === 'area' ? '[Sloped Area]' : '[Sloped Length]';
      const qty = findProp(props, 'Qty');
      if (qty && useForQty && qty.formula.trim() === measured) qty.formula = sloped;
      if (qty && !useForQty && qty.formula.trim() === sloped) qty.formula = measured;
      this.estimate.elementProps[name] = props;
    }
    this.pitchOpen = false;
    this.estimateChanged();
    this.showToast(`Pitch ${pitch}/12 applied to ${names.length === 1 ? names[0] : names.length + ' items'}`);
  }

  // Value of one property of a row ("1,250.00", units "SF")
  rowValue(key: string, name: string): EvalResult {
    return evaluate(this.evalNode(key), name);
  }

  partName(part: Part): string {
    const value = evaluate({ props: part.props, takeoff: null, parent: null }, 'Name').value;
    return String(value || 'New Part');
  }

  estimateRows(): EstimateRow[] {
    if (!this.hasDocument) return [];
    const rows: EstimateRow[] = [];
    for (const name of this.elementNames()) {
      const info = this.elementInfo(name);
      if (!info) continue;
      rows.push(this.makeRow(name, name, 'element', info.color, info.pages.map(i => this.pageName(i)).join(', ')));
    }
    // Parts on their own (not under an element)
    for (const part of this.estimate.parts.filter(p => p.parentKey === null || !this.rowExists(p.parentKey))) {
      rows.push(this.makeRow(part.id, this.partName(part), 'part', COLORS.gray, ''));
    }
    return rows;
  }

  private rowExists(key: string): boolean {
    return this.isPart(key) || this.elementNames().includes(key);
  }

  private makeRow(key: string, name: string, kind: 'element' | 'part', color: string, pages: string, depth = 0): EstimateRow {
    const qty = this.rowValue(key, 'Qty');
    const subRows = depth > 10 ? [] : this.estimate.parts
      .filter(p => p.parentKey === key)
      .map(p => this.makeRow(p.id, this.partName(p), 'part', COLORS.gray, pages, depth + 1));
    return {
      id: `${kind}-${key}`, key, kind, name, isFolder: false, color,
      quantity: typeof qty.value === 'number' ? qty.value : undefined, unit: qty.units, pages, children: [], subRows,
    };
  }

  // Groups first (with their rows), then the rows that are in no group
  estimateFolders(): EstimateRow[] {
    if (!this.hasDocument) return [];
    const rows = this.estimateRows();
    const grouped = new Set<EstimateRow>();
    const folders: EstimateRow[] = this.estimateGroups.map(g => {
      const children = rows.filter(r => g.rowNames.includes(r.name));
      children.forEach(r => grouped.add(r));
      return { id: g.id, key: g.id, kind: 'folder', name: g.name, isFolder: true, unit: '', pages: '', children, subRows: [] };
    });
    return [...folders, ...rows.filter(r => !grouped.has(r))];
  }

  // Text of a cell of the estimate table, and its number (for totals and Excel)
  cellValue(row: EstimateRow, column: ColumnDef): { text: string; value: number | string | null; units: string } {
    switch (column.name) {
      case 'Name': return { text: row.name, value: row.name, units: '' };
      case 'Pages': return { text: row.pages, value: row.pages, units: '' };
      case 'Color': return { text: row.color ?? '', value: row.color ?? '', units: '' };
    }
    if (row.isFolder) {
      // Groups add up their rows (Qty only when every row uses the same units)
      if (column.type !== 'number') return { text: '', value: null, units: '' };
      const values = row.children.map(c => this.cellValue(c, column));
      const units = new Set(values.map(v => v.units));
      if (values.length === 0 || (column.name === 'Qty' && units.size > 1)) return { text: '', value: null, units: '' };
      const total = values.reduce((sum, v) => sum + (typeof v.value === 'number' ? v.value : 0), 0);
      return { text: formatResult({ value: total, units: '' }, column.decimals), value: total, units: [...units][0] ?? '' };
    }
    const def = findProp(this.rowProps(row.key), column.name);
    const result = this.rowValue(row.key, column.name);
    if (!def && !TAKEOFF_PROPS.includes(column.name)) return { text: '', value: null, units: '' };
    if (typeof result.value === 'number' && column.type === 'number') {
      return { text: formatResult(result, column.decimals), value: result.value, units: result.units };
    }
    return { text: String(result.value), value: result.value, units: result.units };
  }

  selectEstimateRow(key: string | null): void {
    this.selectedEstimateKey = key;
    this.extraEstimateKeys = new Set();
    this.touch();
  }

  // Several rows (Shift + click = a range, Ctrl / ⌘ + click = one more): `primary` is the one
  // Properties and New Part use
  extraEstimateKeys = new Set<string>();

  selectEstimateRows(keys: string[], primary: string | null): void {
    this.selectedEstimateKey = primary ?? keys[0] ?? null;
    this.extraEstimateKeys = new Set(keys.filter(k => k !== this.selectedEstimateKey));
    this.touch();
  }

  get estimateSelection(): string[] {
    return this.selectedEstimateKey ? [this.selectedEstimateKey, ...this.extraEstimateKeys] : [];
  }

  isEstimateSelected(key: string): boolean {
    return !!this.selectedEstimateKey && (this.selectedEstimateKey === key || this.extraEstimateKeys.has(key));
  }

  // MARK: - Properties window
  openProperties(key: string | null = this.selectedEstimateKey): void {
    if (!key || !this.rowExists(key)) return;
    this.propertiesKey = key;
    this.touch();
  }

  closeProperties(): void {
    this.propertiesKey = null;
    this.touch();
  }

  // Ok in the Properties window. Changing the Name of an element renames it everywhere.
  applyProperties(key: string, props: PropertyDef[]): void {
    this.checkpoint();
    this.propertiesKey = null;
    const part = this.estimate.parts.find(p => p.id === key);
    if (part) {
      const oldName = this.partName(part);
      part.props = props;
      const newName = this.partName(part);
      if (newName !== oldName) this.renameEstimateKey(oldName, newName, false);
      this.estimateChanged();
      return;
    }
    const newName = String(evaluate({ props, takeoff: null, parent: null }, 'Name').value).trim();
    let finalKey = key;
    if (newName && newName !== key) {
      // Rename the takeoff items and the PDF markups with this name (without extra Undo steps)
      this.items.filter(i => i.name === key).forEach(item => {
        item.name = newName;
        this.measurements.filter(m => m.itemId === item.id).forEach(m => m.name = newName);
      });
      this.markups.filter(m => m.name === key).forEach(m => m.name = newName);
      this.renameEstimateKey(key, newName, true);
      finalKey = newName;
    }
    this.estimate.elementProps[finalKey] = props;
    this.estimateChanged();
  }

  // An element or part changed its name: its groups, properties and sub-items follow it
  private renameEstimateKey(oldName: string, newName: string, isElement: boolean): void {
    for (const g of this.estimateGroups) g.rowNames = g.rowNames.map(n => n === oldName ? newName : n);
    if (!isElement) return;
    const props = this.estimate.elementProps[oldName];
    if (props) {
      delete this.estimate.elementProps[oldName];
      const name = findProp(props, 'Name');
      if (name) name.formula = newName;
      this.estimate.elementProps[newName] = props;
    }
    this.estimate.parts.forEach(p => { if (p.parentKey === oldName) p.parentKey = newName; });
    if (this.selectedEstimateKey === oldName) this.selectedEstimateKey = newName;
  }

  // MARK: - Parts
  // New Part: on its own, or as a sub-item of the selected element / part
  newPart(asSubItem: boolean): void {
    if (!this.hasDocument) return;
    const parentKey = asSubItem ? this.selectedEstimateKey : null;
    if (asSubItem && (!parentKey || !this.rowExists(parentKey))) {
      this.showToast('Select an element in the estimate first', true);
      return;
    }
    this.checkpoint();
    const part: Part = { id: `part-${uid()}`, parentKey, props: partTemplate() };
    this.estimate.parts.push(part);
    if (parentKey) this.estimateCollapsed.delete(`${this.isPart(parentKey) ? 'part' : 'element'}-${parentKey}`);
    this.selectedEstimateKey = part.id;
    this.propertiesKey = part.id;                 // name it right away
    this.estimateChanged();
  }

  // A part of the estimate dragged onto another element or part becomes its child (with its sub-parts)
  movePart(partId: string, parentKey: string): void {
    const part = this.estimate.parts.find(p => p.id === partId);
    if (!part || part.parentKey === parentKey || partId === parentKey || !this.rowExists(parentKey)) return;
    // Not under itself or one of its own sub-parts
    let key: string | null = parentKey;
    for (let guard = 0; key && guard < 50; guard++) {
      if (key === partId) return;
      const above: string = key;
      key = this.estimate.parts.find(x => x.id === above)?.parentKey ?? null;
    }
    this.checkpoint();
    part.parentKey = parentKey;
    this.estimateCollapsed.delete(`${this.isPart(parentKey) ? 'part' : 'element'}-${parentKey}`);
    this.estimateChanged();
  }

  get canAddSubItem(): boolean {
    return !!this.selectedEstimateKey && this.rowExists(this.selectedEstimateKey);
  }

  // Delete in the estimate: a part (with its sub-items) or a group (its rows stay)
  // Every selected part (with its sub-items) and group (its rows stay), as one Undo step
  deleteEstimateSelection(): void {
    const keys = this.estimateSelection;
    if (keys.length === 0) return;
    const groups = keys.filter(k => this.estimateGroups.some(g => g.id === k));
    const parts = keys.filter(k => this.isPart(k));
    // Elements: deleted on the plan too (their measurements and PDF markups)
    const elements = keys.filter(k => !groups.includes(k) && !parts.includes(k));
    const onPlan = new Set(elements.flatMap(name => this.elementsNamed(name)));
    if (groups.length === 0 && parts.length === 0 && onPlan.size === 0) return;
    this.checkpoint();
    if (onPlan.size) {
      this.removeElements(onPlan);
      this.showToast(`Deleted ${elements.length} element${elements.length === 1 ? '' : 's'} and ${onPlan.size} markup${onPlan.size === 1 ? '' : 's'} on the plan (Undo restores them)`);
    }
    const gone = new Set<string>(parts);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.estimate.parts) {
        if (p.parentKey && gone.has(p.parentKey) && !gone.has(p.id)) { gone.add(p.id); grew = true; }
      }
    }
    this.estimate.parts = this.estimate.parts.filter(p => !gone.has(p.id));
    this.estimateGroups = this.estimateGroups.filter(g => !groups.includes(g.id));
    this.selectedEstimateKey = null;
    this.extraEstimateKeys = new Set();
    this.estimateChanged();
  }

  // MARK: - Filter builder (Estimating › Filter): only the rows that pass it are shown
  estimateFilter: FilterGroup | null = parseFilter(readSetting('estimateFilter') ?? '');
  filterOpen = false;

  // Name of the saved filter in use ('' = a filter without a name)
  estimateFilterName = readSetting('estimateFilterName') ?? '';
  // Filters saved with a name (in this browser, for every document)
  savedFilters: NamedFilter[] = loadSavedFilters();

  get filterActive(): boolean { return !isFilterEmpty(this.estimateFilter); }

  saveNamedFilter(name: string, filter: FilterGroup, id?: string): NamedFilter {
    const trimmed = name.trim() || 'Filter';
    let entry = id ? this.savedFilters.find(f => f.id === id) : undefined;
    if (entry) {
      entry.name = trimmed;
      entry.filter = structuredClone(filter);
    } else {
      entry = { id: `filter-${uid()}`, name: trimmed, filter: structuredClone(filter) };
      this.savedFilters.push(entry);
    }
    this.savedFilters.sort((a, b) => a.name.localeCompare(b.name));
    writeSetting('savedFilters', JSON.stringify(this.savedFilters));
    this.touch();
    return entry;
  }

  deleteNamedFilter(id: string): void {
    this.savedFilters = this.savedFilters.filter(f => f.id !== id);
    writeSetting('savedFilters', JSON.stringify(this.savedFilters));
    this.touch();
  }

  // Estimating › Filter menu: use a saved (or ready-made) filter right away
  useNamedFilter(entry: NamedFilter): void {
    this.setEstimateFilter(entry.filter, entry.name);
  }

  openFilter(): void {
    this.filterOpen = true;
    this.touch();
  }

  closeFilter(): void {
    this.filterOpen = false;
    this.touch();
  }

  setEstimateFilter(filter: FilterGroup | null, name = ''): void {
    this.estimateFilter = filter && !isFilterEmpty(filter) ? structuredClone(filter) : null;
    this.estimateFilterName = this.estimateFilter ? name : '';
    writeSetting('estimateFilter', this.estimateFilter ? JSON.stringify(this.estimateFilter) : '');
    writeSetting('estimateFilterName', this.estimateFilterName);
    this.touch();
  }

  // Every row of the estimate (groups' rows and parts included), for counting what a filter shows
  allEstimateRows(): EstimateRow[] {
    const out: EstimateRow[] = [];
    const add = (r: EstimateRow) => { out.push(r); r.subRows.forEach(add); };
    this.estimateRows().forEach(add);
    return out;
  }

  // One field of a row, for the filters: a property, or IsTakeoffItem / IsPart / Name / Type / Pages / Color
  filterValue(row: EstimateRow, field: string): unknown {
    switch (field) {
      case 'IsTakeoffItem': return row.kind === 'element' ? 'True' : 'False';      // measured or PDF markup element
      case 'IsPart': return row.kind === 'part' ? 'True' : 'False';
      case 'Name': return row.name;
      case 'Pages': return row.pages;
      case 'Color': return row.color ?? '';
    }
    if (row.isFolder) return '';
    return this.rowValue(row.key, field).value;
  }

  rowPassesFilter(row: EstimateRow): boolean {
    const f = this.estimateFilter;
    return !f || isFilterEmpty(f) || matchesFilter(f, field => this.filterValue(row, field));
  }

  // MARK: - Columns window
  openColumns(): void {
    this.columnsOpen = true;
    this.touch();
  }

  closeColumns(): void {
    this.columnsOpen = false;
    this.touch();
  }

  applyColumns(columns: ColumnDef[]): void {
    this.checkpoint();
    this.estimate.columns = columns;
    this.columnsOpen = false;
    this.estimateChanged();
  }

  // Dragging the edge of a column header. `done` saves it (one Undo step per drag).
  setColumnWidth(id: string, width: number, done: boolean): void {
    const column = this.estimate.columns.find(c => c.id === id);
    if (!column) return;
    if (done) this.checkpoint('column-width');
    column.width = Math.max(40, Math.round(width));
    if (done) this.estimateChanged(); else this.touch();
  }

  get visibleColumns(): ColumnDef[] {
    return this.estimate.columns.filter(c => c.visible);
  }

  // Property names known in the document (for the column and group pickers)
  get knownPropertyNames(): string[] {
    const names = new Set<string>(['Name', 'Pages', 'Color']);
    const lists = [elementTemplate('count', ''), ...Object.values(this.estimate.elementProps),
      ...this.estimate.parts.map(p => p.props)];
    lists.forEach(list => list.forEach(p => names.add(p.name)));
    return [...names];
  }

  // MARK: - Groups
  newEstimateGroup(): void {
    if (!this.hasDocument) return;
    this.checkpoint();
    const used = new Set(this.estimateGroups.map(g => g.name));
    let n = this.estimateGroups.length + 1;
    while (used.has(`Group ${n}`)) n++;
    this.estimateGroups.push({ id: `group-${uid()}`, name: `Group ${n}`, rowNames: [] });
    this.estimateChanged();
  }

  renameEstimateGroup(id: string, name: string): void {
    const group = this.estimateGroups.find(g => g.id === id);
    const trimmed = name.trim();
    if (!group || !trimmed || trimmed === group.name) return;
    this.checkpoint();
    group.name = trimmed;
    this.estimateChanged();
  }

  // Deleting a group keeps its rows: they go back to the ungrouped list
  deleteEstimateGroup(id: string): void {
    this.checkpoint();
    this.estimateGroups = this.estimateGroups.filter(g => g.id !== id);
    if (this.selectedEstimateKey === id) this.selectedEstimateKey = null;
    this.estimateChanged();
  }

  // Several rows (by name) into a group, or out of every group, as one Undo step
  moveManyToEstimateGroup(rowNames: string[], groupId: string | null): void {
    const target = groupId ? this.estimateGroups.find(g => g.id === groupId) : null;
    const names = rowNames.filter(n => target ? !target.rowNames.includes(n) : this.estimateGroups.some(g => g.rowNames.includes(n)));
    if (names.length === 0) return;
    this.checkpoint();
    for (const g of this.estimateGroups) g.rowNames = g.rowNames.filter(n => !names.includes(n));
    target?.rowNames.push(...names);
    this.estimateChanged();
  }

  // Moves a row (by name) into a group, or out of every group (groupId = null)
  moveToEstimateGroup(rowName: string, groupId: string | null): void {
    const target = groupId ? this.estimateGroups.find(g => g.id === groupId) : null;
    if (target?.rowNames.includes(rowName)) return;
    if (!target && !this.estimateGroups.some(g => g.rowNames.includes(rowName))) return;
    this.checkpoint();
    for (const g of this.estimateGroups) g.rowNames = g.rowNames.filter(n => n !== rowName);
    target?.rowNames.push(rowName);
    this.estimateChanged();
  }

  // The estimate is saved inside the PDF on Save, and kept in this browser meanwhile
  estimateChanged(): void {
    if (this.fileName) writeSetting(`estimate:${this.fileName}`, JSON.stringify(this.estimate));
    this.touch();
  }

  // On open: the data saved in the PDF; if it has none, what this browser kept for that file name
  private loadEstimate(fromPdf: string | null): void {
    const parse = (text: string | null): EstimateData | null => {
      if (!text) return null;
      try {
        const data = JSON.parse(text) as Partial<EstimateData>;
        return {
          version: 1,
          groups: Array.isArray(data.groups) ? data.groups : [],
          elementProps: data.elementProps && typeof data.elementProps === 'object' ? data.elementProps : {},
          parts: Array.isArray(data.parts) ? data.parts.map(p => ({ ...p, props: upgradeProps(p.props ?? [], null) })) : [],
          columns: Array.isArray(data.columns) && data.columns.length ? data.columns : defaultColumns(),
        };
      } catch {
        return null;
      }
    };
    const legacyGroups = (() => {
      try { return JSON.parse(readSetting(`estimateGroups:${this.fileName}`) ?? 'null') as EstimateGroup[] | null; }
      catch { return null; }
    })();
    this.estimate = parse(fromPdf) ?? parse(readSetting(`estimate:${this.fileName}`)) ?? emptyEstimate();
    if (!fromPdf && Array.isArray(legacyGroups) && this.estimate.groups.length === 0) this.estimate.groups = legacyGroups;
    this.selectedEstimateKey = null;
    this.propertiesKey = null;
    this.columnsOpen = false;
  }

  // Saves the estimate as an Excel file (.xlsx) with the visible columns:
  // one row per group with its totals, its rows indented below (parts under their element)
  exportExcel(): void {
    const rows = this.estimateFolders();
    if (rows.length === 0) return;
    const columns = this.visibleColumns;
    const header: Cell[] = [];
    const widths: number[] = [];
    for (const c of columns) {
      header.push({ value: c.name, style: 'header' });
      widths.push(c.name === 'Name' ? 40 : c.type === 'number' ? 14 : 24);
      if (c.showUnits) { header.push({ value: 'Units', style: 'header' }); widths.push(8); }
    }
    const cells: Cell[][] = [header];
    const line = (row: EstimateRow, depth: number) => {
      const out: Cell[] = [];
      const group = row.isFolder;
      for (const c of columns) {
        const v = this.cellValue(row, c);
        if (c.name === 'Name') {
          out.push({ value: '    '.repeat(depth) + row.name, style: group ? 'group' : 'normal' });
        } else if (typeof v.value === 'number' && c.type === 'number') {
          const integer = c.decimals === 0;
          out.push({ value: Number(v.value.toFixed(c.decimals)),
            style: group ? (integer ? 'groupInteger' : 'groupNumber') : (integer ? 'integer' : 'number') });
        } else {
          out.push({ value: v.text, style: group ? 'group' : 'normal' });
        }
        if (c.showUnits) out.push({ value: v.units, style: group ? 'group' : 'normal' });
      }
      cells.push(out);
      row.subRows.forEach(sub => line(sub, depth + 1));
    };
    for (const row of rows) {
      line(row, 0);
      if (row.isFolder) row.children.forEach(child => line(child, 1));
    }
    const base = this.fileName.replace(/\.pdf$/i, '');
    const name = (base ? `${base} Estimate` : 'Estimate') + '.xlsx';
    downloadFile(xlsxBlob({ name: 'Estimate', columns: widths, rows: cells }), name);
    this.showToast(`Exported ${name}`);
  }
}

// "12" for counts, "154.09" for the rest
export function estimateQuantityText(row: EstimateRow): string {
  if (row.quantity === undefined) return '';
  return row.unit === 'ea' ? row.quantity.toFixed(0) : row.quantity.toFixed(2);
}

// Revu writes the measured value in /Contents ("154.09 sf", "52.82 ft").
// If every markup has a value with the same unit, add them up; otherwise count them.
// Size of a PDF markup's shape: area of a polygon (without its holes), length of a line
function markupGeometry(m: Markup): number {
  if (m.subtype === 'Polygon' && m.vertices) return netPolygonArea(m.vertices, m.cutouts);
  const pts = m.subtype === 'Line' ? m.line : m.vertices;
  return pts ? polylineLength(pts) : 0;
}

// "154.09 sf" × ratio → "169.50 sf" (same decimals, thousands separator and unit)
function scaleQuantityText(text: string, ratio: number): string {
  const match = /^(\s*)([0-9][0-9,]*\.?([0-9]*))(.*)$/s.exec(text);
  if (!match || !Number.isFinite(ratio)) return text;
  const value = Number(match[2].replace(/,/g, '')) * ratio;
  const decimals = match[3].length;
  const out = match[2].includes(',')
    ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : value.toFixed(decimals);
  return match[1] + out + match[4];
}

// A Revu area measurement read from the PDF (a polygon with a value)
export function isRevuArea(el: PlanElement): el is Markup {
  return el instanceof Markup && el.subtype === 'Polygon' && /PolygonDimension/.test(el.intent) && (el.vertices?.length ?? 0) >= 3;
}

function markupQuantity(list: Markup[]): [number, string] {
  const regex = /^\s*([0-9][0-9,]*\.?[0-9]*)\s*([A-Za-z ]*)\s*$/;
  let total = 0;
  const units = new Set<string>();
  for (const m of list) {
    const match = regex.exec(m.contents);
    if (!match) return [list.length, 'ea'];
    total += Number(match[1].replace(/,/g, ''));
    units.add(match[2].trim());
  }
  const unit = [...units][0];
  return units.size === 1 && unit ? [total, unit] : [list.length, 'ea'];
}

function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface FileHandleWithPermission extends FileSystemFileHandle {
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

// Write permission on the opened file (Chrome, Edge and Brave ask "Save changes to COMBINED.pdf?" once)
async function ensureWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileHandleWithPermission;
  try {
    if (!h.queryPermission) return true;
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await h.requestPermission?.({ mode: 'readwrite' }) === 'granted';
  } catch {
    return false;
  }
}

function loadSavedFilters(): NamedFilter[] {
  try {
    const list = JSON.parse(readSetting('savedFilters') ?? '[]') as { id?: string; name?: string; filter?: unknown }[];
    return Array.isArray(list) ? list.flatMap(f => {
      const filter = parseFilter(JSON.stringify(f.filter ?? null));
      return filter && f.id ? [{ id: f.id, name: String(f.name ?? 'Filter'), filter }] : [];
    }) : [];
  } catch {
    return [];
  }
}

function readSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}
