import { Injectable, computed, signal } from '@angular/core';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Markup, Measurement, PlanElement } from '../models/elements';
import {
  COLORS, LENGTH_UNITS, LengthUnit, LineStyle, Pt, Rect, ScaleViewport, TakeoffItem, TakeoffKind,
  isArchitecturalScale, kindTitle, kindUnit, polygonArea, polylineLength, quantityText, rectContains,
  scaleName, uid,
} from '../models/takeoff';
import { readPdf, writePdf } from './pdf-file';
import { PageGeometry, SnapIndex, openRenderer } from './pdf-render';
import { Cell, xlsxBlob } from './xlsx';

// Port of DrawingViewModel.swift: the whole state of the app.
// Plain fields hold the data; every change calls touch(), and the views read watch()
// so they redraw (the same idea as the `_ = revision` reads on the Mac).

export type SplitMode = 'single' | 'vertical' | 'horizontal';
export type RibbonTab = 'Home' | 'Estimating';
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
  name: string;
  isFolder: boolean;
  color?: string;
  quantity?: number;
  unit: string;
  pages: string;
  children: EstimateRow[];
}

// Group of rows made by the user in the estimate (rows are matched by name)
export interface EstimateGroup { id: string; name: string; rowNames: string[]; }

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
  groups: EstimateGroup[];
}

// Markup fields that, when Undo changes them, mean the markup must be written again
const MARKUP_FIELDS = ['pageIndex', 'rect', 'vertices', 'line', 'inkList', 'visible', 'subject', 'contents',
  'color', 'fillColor', 'lineWidth'] as const;

// An element's own fields, without its identity and its PDF object (those never go back)
function stateOf(el: object): Record<string, unknown> {
  const { id, ref, pdfRef, ...rest } = el as Record<string, unknown>;
  return rest;
}

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

  // Unit for new measurements (the last one chosen in Properties)
  private lengthUnit: LengthUnit = (LENGTH_UNITS as string[]).includes(readSetting('lengthUnit') ?? '')
    ? readSetting('lengthUnit') as LengthUnit : 'ft';
  get defaultLengthUnit(): LengthUnit { return this.lengthUnit; }
  set defaultLengthUnit(value: LengthUnit) { this.lengthUnit = value; writeSetting('lengthUnit', value); }

  // MARK: - View and tools (bottom bar)
  interaction: InteractionMode = 'select';

  // MARK: - Ribbon tab and estimate table
  ribbonTab: RibbonTab = 'Home';
  estimateCollapsed = new Set<string>();          // folders closed in the estimate table
  estimateGroups: EstimateGroup[] = [];           // groups the user made in the estimate

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
    this.loading = true;
    this.touch();
    try {
      const [opened, renderer] = await Promise.all([readPdf(bytes), openRenderer(bytes)]);
      const pages = await Promise.all(
        Array.from({ length: renderer.numPages }, (_, i) => renderer.getPage(i + 1).then(p => new PageGeometry(p))));
      const labels = await renderer.getPageLabels().catch(() => null);

      this.renderer?.destroy();
      this.lib = opened.lib;
      this.renderer = renderer;
      this.pages = pages;
      this.pageLabels = labels ?? [];
      this.fileName = name;
      this.fileHandle = handle;
      if (handle) void ensureWritePermission(handle);   // asked once now, so Save writes with no prompt
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
      this.loadGroups();
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
    if (!this.hasDocument) return;
    this.renderer?.destroy();
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
    this.estimateGroups = [];
    this.splitMode = 'single';
    this.activePane = 0;
    this.touch();
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
      groups: this.estimateGroups.map(g => ({ ...g, rowNames: [...g.rowNames] })),
    };
  }

  private restore(snap: Snapshot): void {
    const present = new Set(this.markups);
    for (const [m, state] of snap.measurements) Object.assign(m, state);
    for (const [m, state] of snap.markups) {
      const record = m as unknown as Record<string, unknown>;
      const changed = !present.has(m) || MARKUP_FIELDS.some(k => record[k] !== state[k]);
      Object.assign(m, state);
      if (changed) m.dirty = true;                     // written again on the next save
    }
    this.measurements = snap.measurements.map(([m]) => m);
    this.markups = snap.markups.map(([m]) => m);
    this.removed = snap.removed;
    this.items = snap.items;
    this.pageScales = snap.pageScales;
    this.viewports = snap.viewports;
    this.current = snap.current;
    this.countSession = snap.countSession;
    this.estimateGroups = snap.groups;
    this.selection = this.selection.filter(el =>
      el instanceof Measurement ? this.measurements.includes(el) : this.markups.includes(el));
    if (this.continuingTemplate && !this.markups.includes(this.continuingTemplate)) this.continuingTemplate = null;
    if (this.selectedItemId && !this.items.some(i => i.id === this.selectedItemId)) this.selectedItemId = null;
    this.measurements.forEach(m => this.updateCaption(m));
    this.groupsChanged();
  }

  // MARK: - Tabs and messages
  showTab(tab: RibbonTab): void {
    // The estimate covers the plan: stop measuring and clear the selection first
    if (tab === 'Estimating') {
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
    if (this.activePane === pane) return;
    this.activePane = pane;
    this.touch();
  }

  setSplit(mode: SplitMode): void {
    if (mode !== 'single' && this.splitMode === 'single') this.pageIndexes[1] = this.pageIndexes[0];
    this.splitMode = mode;
    if (mode === 'single') this.activePane = 0;
    this.touch();
  }

  // Closes a pane; the other one becomes the only view
  closePane(index: number): void {
    if (index === 0) this.pageIndexes[0] = this.pageIndexes[1];   // the second pane becomes the only one
    this.setSplit('single');
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
    const trimmed = name.trim();
    if (trimmed) this.pageNames.set(index, trimmed); else this.pageNames.delete(index);
    this.touch();
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

  deleteSelected(): void {
    if (this.selection.length === 0) return;
    this.checkpoint();
    const gone = new Set<PlanElement>(this.selection);
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
    this.selection = [];
    this.touch();
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

  // Unit of the caption; new measurements use the last one chosen
  get measureLengthUnit(): LengthUnit { return this.selectedMeasurements[0]?.lengthUnit ?? this.defaultLengthUnit; }
  set measureLengthUnit(v: LengthUnit) {
    this.defaultLengthUnit = v;
    this.editMeasurements(m => m.lengthUnit = v);
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
    const total = list.reduce((sum, m) => sum + this.value(m.points, m.kind, m.pageIndex), 0);
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
    // Its estimate group follows the new name
    for (const g of this.estimateGroups) g.rowNames = g.rowNames.map(n => n === item.name ? name : n);
    item.name = name;
    this.measurements.filter(m => m.itemId === itemId).forEach(m => m.name = name);
    this.touch();
  }

  // Group of PDF markups (Revu or others): changes the Subject of all of them
  renameMarkups(markups: Markup[], name: string): void {
    this.checkpoint('name');
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
      : quantityText(this.value(m.points, item.kind, m.pageIndex), item.kind, m.lengthUnit);
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
    if (!handle || !('createWritable' in handle)) return this.saveAs();
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
    return quantityText(this.value(points, kind, pageIndex), kind, this.defaultLengthUnit);
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
      m.lengthUnit = this.defaultLengthUnit;
      m.arrowEnds = item.name === 'Dimension';       // Dimension: arrows on both ends
      m.visible = item.isVisible;
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

  // MARK: - Top bar (Area, Linear, Segment, Count, Dimension)
  takeoffItems(kind: TakeoffKind): TakeoffItem[] {
    return this.items.filter(i => i.kind === kind && i.name !== 'Dimension');
  }

  // Large button: continue with the last item of that type, or create a new one
  startTakeoff(kind: TakeoffKind): void {
    const list = this.takeoffItems(kind);
    const item = list[list.length - 1];
    if (item) this.select(item.id); else this.newTakeoff(kind);
  }

  // "Area 2", "Count 3"… with the next color of the palette
  newTakeoff(kind: TakeoffKind): void {
    const number = this.takeoffItems(kind).length + 1;
    this.addItem(`${kindTitle(kind)} ${number}`, kind, PALETTE[this.items.length % PALETTE.length]);
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
      .reduce((sum, m) => sum + this.value(m.points, item.kind, pageIndex), 0);
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

  // MARK: - Estimate ("Estimating" tab)
  // Every element with its total: app takeoff items and the markups already in the PDF (Revu, etc.).
  // Nothing is grouped by default: the user makes groups (folders) and drags rows into them.
  // Rows are matched to groups by name, so the groups survive saving and reopening the file.
  estimateRows(): EstimateRow[] {
    if (!this.hasDocument) return [];
    const rows: EstimateRow[] = [];
    for (const item of this.items) {
      const pageIndexes = [...new Set(this.measurements.filter(m => m.itemId === item.id).map(m => m.pageIndex))]
        .sort((a, b) => a - b);
      if (pageIndexes.length === 0) continue;
      const total = pageIndexes.reduce((sum, i) => sum + this.quantity(item, i), 0);
      rows.push({
        id: `item-${item.id}`, name: item.name, isFolder: false, color: item.color, quantity: total,
        unit: kindUnit(item.kind), pages: pageIndexes.map(i => this.pageName(i)).join(', '), children: [],
      });
    }

    // PDF markups grouped by name across all pages
    const markups = new Map<string, { list: Markup[]; pages: number[] }>();
    for (let i = 0; i < this.pageCount; i++) {
      for (const group of this.markupGroups(i)) {
        const entry = markups.get(group.name) ?? { list: [], pages: [] };
        entry.list.push(...group.markups);
        entry.pages.push(i);
        markups.set(group.name, entry);
      }
    }
    for (const name of [...markups.keys()].sort()) {
      const entry = markups.get(name)!;
      const [quantity, unit] = markupQuantity(entry.list);
      rows.push({
        id: `markup-${name}`, name: name || 'Untitled', isFolder: false,
        color: entry.list[0].color ?? COLORS.gray, quantity, unit,
        pages: entry.pages.map(i => this.pageName(i)).join(', '), children: [],
      });
    }
    return rows;
  }

  // Groups first (with their rows), then the rows that are in no group
  estimateFolders(): EstimateRow[] {
    if (!this.hasDocument) return [];
    const rows = this.estimateRows();
    const grouped = new Set<EstimateRow>();
    const folders: EstimateRow[] = this.estimateGroups.map(g => {
      const children = rows.filter(r => g.rowNames.includes(r.name));
      children.forEach(r => grouped.add(r));
      return { id: g.id, name: g.name, isFolder: true, unit: '', pages: '', children };
    });
    return [...folders, ...rows.filter(r => !grouped.has(r))];
  }

  newEstimateGroup(): void {
    if (!this.hasDocument) return;
    this.checkpoint();
    const used = new Set(this.estimateGroups.map(g => g.name));
    let n = this.estimateGroups.length + 1;
    while (used.has(`Group ${n}`)) n++;
    this.estimateGroups.push({ id: `group-${uid()}`, name: `Group ${n}`, rowNames: [] });
    this.groupsChanged();
  }

  renameEstimateGroup(id: string, name: string): void {
    const group = this.estimateGroups.find(g => g.id === id);
    const trimmed = name.trim();
    if (!group || !trimmed || trimmed === group.name) return;
    this.checkpoint();
    group.name = trimmed;
    this.groupsChanged();
  }

  // Deleting a group keeps its rows: they go back to the ungrouped list
  deleteEstimateGroup(id: string): void {
    this.checkpoint();
    this.estimateGroups = this.estimateGroups.filter(g => g.id !== id);
    this.groupsChanged();
  }

  // Moves a row (by name) into a group, or out of every group (groupId = null)
  moveToEstimateGroup(rowName: string, groupId: string | null): void {
    const target = groupId ? this.estimateGroups.find(g => g.id === groupId) : null;
    if (target?.rowNames.includes(rowName)) return;
    if (!target && !this.estimateGroups.some(g => g.rowNames.includes(rowName))) return;
    this.checkpoint();
    for (const g of this.estimateGroups) g.rowNames = g.rowNames.filter(n => n !== rowName);
    target?.rowNames.push(rowName);
    this.groupsChanged();
  }

  // Groups are remembered per file name in this browser
  private groupsChanged(): void {
    if (this.fileName) writeSetting(`estimateGroups:${this.fileName}`, JSON.stringify(this.estimateGroups));
    this.touch();
  }

  private loadGroups(): void {
    try {
      const saved = JSON.parse(readSetting(`estimateGroups:${this.fileName}`) ?? '[]') as EstimateGroup[];
      this.estimateGroups = Array.isArray(saved) ? saved : [];
    } catch {
      this.estimateGroups = [];
    }
  }

  // Saves the estimate as an Excel file (.xlsx): one row per group with its subtotal
  // (when all its rows use the same unit), its rows indented below, then the rows in no group
  exportExcel(): void {
    const rows = this.estimateFolders();
    if (rows.length === 0) return;
    const isCount = (row: EstimateRow) => row.unit === 'ea';
    const qty = (row: EstimateRow): Cell =>
      ({ value: row.quantity === undefined ? null : Number(estimateQuantityText(row)), style: isCount(row) ? 'integer' : 'number' });
    const line = (row: EstimateRow, indent: boolean): Cell[] => [
      { value: (indent ? '    ' : '') + row.name }, qty(row), { value: row.unit }, { value: row.pages },
    ];
    const cells: Cell[][] = [[
      { value: 'Name', style: 'header' }, { value: 'Qty', style: 'header' },
      { value: 'Units', style: 'header' }, { value: 'Pages', style: 'header' },
    ]];
    for (const row of rows) {
      if (!row.isFolder) {
        cells.push(line(row, false));
        continue;
      }
      const units = new Set(row.children.map(c => c.unit));
      const unit = units.size === 1 ? [...units][0] : '';
      const total = unit ? row.children.reduce((sum, c) => sum + (c.quantity ?? 0), 0) : null;
      cells.push([
        { value: row.name, style: 'group' },
        { value: total === null ? null : Number(total.toFixed(unit === 'ea' ? 0 : 2)), style: unit === 'ea' ? 'groupInteger' : 'groupNumber' },
        { value: unit, style: 'group' },
        { value: '', style: 'group' },
      ]);
      row.children.forEach(child => cells.push(line(child, true)));
    }
    const base = this.fileName.replace(/\.pdf$/i, '');
    const name = (base ? `${base} Estimate` : 'Estimate') + '.xlsx';
    downloadFile(xlsxBlob({ name: 'Estimate', columns: [40, 14, 10, 30], rows: cells }), name);
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

function readSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}
