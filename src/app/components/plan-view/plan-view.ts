import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, input,
  signal, untracked, viewChild,
} from '@angular/core';
import type { RenderTask } from 'pdfjs-dist';
import { Markup, Measurement, PlanElement } from '../../models/elements';
import { COLORS, Pt, Rect, rectFromPoints, rectsIntersect } from '../../models/takeoff';
import { DrawingStore, OverlayState } from '../../services/drawing.store/drawing.store';
import { PageGeometry, renderRegion } from '../../services/pdf-render/pdf-render';
import { captureSnapshot } from '../../services/snapshot/snapshot';
import { OcrService } from '../../services/ocr/ocr';
import { PageLabeler } from '../../services/page-labels/page-labels';
import { MarkupTools } from '../../services/markup-tools/markup-tools';
import { Shape, TEXT_FONT, markupShapes, pageShapes, pathOf, rectPath, viewportShapes } from '../../services/shapes/shapes';
import { TextSearch } from '../../services/text-search/text-search';
import { OverlayPanel } from '../overlay-panel/overlay-panel';
import { SvgShapes } from '../svg-shapes/svg-shapes';

const MIN_ZOOM = 0.05;
type DragMode = 'pan' | 'move' | 'marquee' | 'viewport' | 'ocr' | 'snapshot' | 'overlay' | 'markup' | 'labels';
const MAX_ZOOM = 40;
const MAX_CANVAS_PIXELS = 16_000_000;     // Safari's canvas limit is about 16.7 M pixels

// One plan pane (port of MeasurementPDFView, PDFContainerView, LivePreviewView and DrawingView):
// the page drawn by pdf.js on canvases, and an SVG layer on top with the markups,
// the measurements, the selection and the measurement in progress.
@Component({
  selector: 'app-plan-view',
  imports: [OverlayPanel, SvgShapes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .markup-editor { position: absolute; z-index: 5; box-sizing: border-box; resize: none; overflow: hidden; line-height: 1.2;
      background: rgba(255, 255, 255, 0.92); border: 1px dashed #007aff; border-radius: 0; outline: none; white-space: pre-wrap; }
    .tint-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
    .overlay-canvas { transform-origin: 50% 50%; pointer-events: none; }
  `],
  template: `
    <div #host class="plan-host" [style.cursor]="cursor()"
         (mousedown)="onMouseDown($event)" (mousemove)="onHover($event)" (mouseleave)="hover.set(null)"
         (dblclick)="onDoubleClick($event)"
         (contextmenu)="$event.preventDefault()">
      @if (geometry(); as g) {
        <div class="plan-stage" [style.width.px]="g.width" [style.height.px]="g.height"
             [style.transform]="'translate(' + ox() + 'px,' + oy() + 'px) scale(' + zoom() + ')'">
          <canvas #background class="plan-canvas" [style.filter]="baseFilter()"></canvas>
          <canvas #detail class="plan-canvas detail" [style.filter]="baseFilter()"></canvas>
          <!-- Overlay: the other page on top, in its own color, moved / scaled / rotated -->
          @if (overlayHere(); as o) {
            @if (overlaySource(); as src) {
              <canvas #overlayCanvas class="plan-canvas overlay-canvas"
                      [style.width.px]="src.width" [style.height.px]="src.height"
                      [style.transform]="overlayTransform(o)" [style.opacity]="o.opacity"
                      [style.filter]="'url(#cp-tint-top-' + pane() + ')'"></canvas>
            }
          }
          <svg class="plan-overlay" [attr.width]="g.width" [attr.height]="g.height"
               [attr.viewBox]="'0 0 ' + g.width + ' ' + g.height">
            <g [appShapes]="shapes()"></g>
            <g [appShapes]="ocrShapes()"></g>
            <g [appShapes]="searchShapes()"></g>
            <g [appShapes]="liveShapes()"></g>
            <g [appShapes]="markupPreview()"></g>
          </svg>
        </div>
        <!-- Text of a text box or callout, typed right on the plan -->
        @if (editor(); as ed) {
          <textarea #editorField class="markup-editor" [value]="ed.markup.contents" placeholder="Type…"
                    [style.left.px]="ed.box.x" [style.top.px]="ed.box.y" [style.width.px]="ed.box.w"
                    [style.min-height.px]="ed.box.h" [style.font-size.px]="ed.fontSize" [style.color]="ed.color"
                    [style.font-family]="textFont" [style.padding.px]="ed.padding"
                    (mousedown)="$event.stopPropagation()" (blur)="commitEditor($event)"
                    (keydown)="editorKey($event)"></textarea>
        }
        <!-- Color filters of the overlay: dark lines take the color, white becomes transparent -->
        <svg class="tint-defs" width="0" height="0" aria-hidden="true">
          <filter [attr.id]="'cp-tint-base-' + pane()" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" [attr.values]="tintMatrix(overlayHere()?.baseColor ?? '#000000')" />
          </filter>
          <filter [attr.id]="'cp-tint-top-' + pane()" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" [attr.values]="tintMatrix(overlayHere()?.overlayColor ?? '#000000')" />
          </filter>
        </svg>
        @if (showOverlayPanel()) { <app-overlay-panel /> }
      } @else {
        <div class="plan-empty">
          @if (store.watch().loading) { Opening… } @else { Open a drawing (⌘O) or drop a PDF here }
        </div>
      }
    </div>
  `,
})
export class PlanView implements OnDestroy {
  readonly pane = input.required<number>();
  readonly store = inject(DrawingStore);
  readonly markups = inject(MarkupTools);
  readonly search = inject(TextSearch);
  readonly textFont = TEXT_FONT;
  private readonly editorField = viewChild<ElementRef<HTMLTextAreaElement>>('editorField');
  readonly ocr = inject(OcrService);
  readonly labeler = inject(PageLabeler);
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly backgroundCanvas = viewChild<ElementRef<HTMLCanvasElement>>('background');
  private readonly detailCanvas = viewChild<ElementRef<HTMLCanvasElement>>('detail');

  // View state: zoom (screen pixels per PDF point) and where the page's top-left corner is
  readonly zoom = signal(1);
  readonly ox = signal(0);
  readonly oy = signal(0);
  private readonly size = signal({ w: 0, h: 0 });

  // Cursor in page coordinates (null = outside or not measuring)
  readonly hover = signal<{ point: Pt; snapped: boolean } | null>(null);
  // Selection or viewport box being dragged (view coordinates)
  private readonly marquee = signal<Rect | null>(null);

  readonly pageIndex = computed(() => this.store.watch().pageIndexes[this.pane()]);
  readonly geometry = computed(() => this.store.watch().pages[this.pageIndex()] ?? null);

  // Overlay drawn on this pane (only on its base page) and the page on top
  readonly overlayHere = computed<OverlayState | null>(() => {
    const o = this.store.overlay();
    return o && o.baseIndex === this.pageIndex() ? o : null;
  });
  readonly overlaySource = computed<PageGeometry | null>(() => {
    const o = this.overlayHere();
    return o ? this.store.watch().pages[o.sourceIndex] ?? null : null;
  });
  readonly baseFilter = computed(() => this.overlayHere()?.baseColor ? `url(#cp-tint-base-${this.pane()})` : null);
  // The overlay controls go in the pane that shows the base page (or the active pane)
  readonly showOverlayPanel = computed(() => {
    const s = this.store.watch();
    const o = this.store.overlay();
    if (!o) return false;
    const onBase = s.pageIndexes.findIndex((p, i) => p === o.baseIndex && (i === 0 || s.splitMode !== 'single'));
    return onBase >= 0 ? onBase === this.pane() : s.activePane === this.pane();
  });
  private readonly overlayCanvas = viewChild<ElementRef<HTMLCanvasElement>>('overlayCanvas');
  private overlayDrawn: { canvas: HTMLCanvasElement; source: PageGeometry } | null = null;
  // Snapshot being pasted: center of the picture under the cursor (view coordinates)
  private readonly ghost = signal<Pt | null>(null);

  overlayTransform(o: OverlayState): string {
    return `translate(${o.dx}px, ${o.dy}px) rotate(${o.rotation}deg) scale(${o.scale})`;
  }

  // Color matrix: every channel becomes the color, alpha = how dark the pixel was (white and empty stay clear)
  tintMatrix(hex: string): string {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => (parseInt(h.slice(i, i + 2), 16) || 0) / 255);
    return `0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  -0.2126 -0.7152 -0.0722 1 0`;
  }

  readonly cursor = computed(() => {
    const s = this.store.watch();
    if (s.snapshotMode === 'capture' || this.labeler.selecting()) return 'crosshair';
    if (s.snapshotMode === 'place') return 'copy';
    if (this.overlayHere()?.adjusting) return 'move';
    if (s.tool !== 'none' || s.drawingViewport || this.markups.tool() || this.ocr.drawingRegion()) return 'crosshair';
    if (this.panning()) return 'grabbing';
    switch (s.interaction) {
      case 'pan': return 'grab';
      case 'zoom': return 'zoom-in';
      default: return 'default';
    }
  });
  private readonly panning = signal(false);

  // Markups, measurements and selection of this page
  readonly shapes = computed<Shape[]>(() => {
    const s = this.store.watch();
    this.store.geometry();
    const g = this.geometry();
    return g ? pageShapes(s, this.pageIndex(), g, this.zoom()) : [];
  });

  // OCR: recognized words (soft yellow) and the word picked in the OCR panel (orange frame)
  readonly ocrShapes = computed<Shape[]>(() => {
    this.store.watch();
    const g = this.geometry();
    if (!g) return [];
    const px = 1 / this.zoom();
    const shapes: Shape[] = [];
    if (this.ocr.showHighlights()) {
      this.ocr.results();
      for (const word of this.ocr.wordsOn(this.pageIndex())) {
        shapes.push({ d: rectPath(word.view), fill: COLORS.yellow, fillOpacity: 0.28, stroke: 'none', width: 0, opacity: 1 });
      }
    }
    const focus = this.ocr.focus();
    if (focus && focus.page === g) {
      const r = focus.view, m = 3 * px;
      shapes.push({ d: rectPath({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }), fill: COLORS.orange,
        fillOpacity: 0.2, stroke: COLORS.orange, width: 2 * px, opacity: 1 });
    }
    return shapes;
  });

  // Live layer: measurement in progress, line to the cursor, snap marker, quantity label, marquee
  readonly liveShapes = computed<Shape[]>(() => {
    const s = this.store.watch();
    const g = this.geometry();
    if (!g) return [];
    const px = 1 / this.zoom();
    const shapes: Shape[] = [];

    const box = this.marquee();
    if (box) {
      shapes.push({ d: rectPath(box), fill: COLORS.blue, fillOpacity: 0.12, stroke: COLORS.blue, width: px,
        dash: `${4 * px} ${3 * px}`, opacity: 1 });
    }

    // Snapshot being pasted: the picture follows the cursor
    const ghost = this.ghost();
    const clip = s.snapshotClip;
    if (s.snapshotMode === 'place' && ghost && clip) {
      const r = { x: ghost.x - clip.w / 2, y: ghost.y - clip.h / 2, w: clip.w, h: clip.h };
      shapes.push({ href: clip.url, x: r.x, y: r.y, w: r.w, h: r.h, fill: 'none', stroke: 'none', width: 0, opacity: 0.6 });
      shapes.push({ d: rectPath(r), fill: 'none', stroke: COLORS.blue, width: px, dash: `${4 * px} ${3 * px}`, opacity: 1 });
    }

    const live = s.liveKind;
    if (s.tool === 'none' || !live) return shapes;
    const progress = s.livePoints;
    const hover = this.hover();
    // Viewport under the cursor (only while measuring)
    shapes.push(...viewportShapes(s, this.pageIndex(), g, this.zoom(), hover?.point ?? null));
    if (progress && progress.pageIndex !== this.pageIndex()) return shapes;
    const placed = (progress?.points ?? []).map(p => g.toView(p));
    const cursor = hover ? g.toView(hover.point) : null;
    const color = live.color;

    // Snap marker: green square on the vertex the cursor jumped to
    if (hover?.snapped && cursor) {
      shapes.push({ d: rectPath({ x: cursor.x - 6 * px, y: cursor.y - 6 * px, w: 12 * px, h: 12 * px }),
        fill: 'none', stroke: COLORS.green, width: 2 * px, opacity: 1 });
    }

    if (live.kind === 'count') {
      for (const v of placed) shapes.push({ d: circle(v, 5 * px), fill: color, stroke: 'none', width: 0, opacity: 1 });
      if (cursor) shapes.push({ d: circle(cursor, 6 * px), fill: color, stroke: 'none', width: 0, opacity: 0.5 });
    } else {
      if (placed.length > 1) shapes.push({ d: pathOf(placed, false), fill: 'none', stroke: color, width: 2 * px, opacity: 1 });
      for (const v of placed) shapes.push({ d: circle(v, 3 * px), fill: color, stroke: 'none', width: 0, opacity: 1 });
      // Dashed line to the cursor (and back to the start for areas)
      const last = placed[placed.length - 1];
      if (cursor && last) {
        const rubber = [last, cursor];
        if (live.kind === 'area' && placed.length > 1) rubber.push(placed[0]);
        shapes.push({ d: pathOf(rubber, false), fill: 'none', stroke: color, width: 1.5 * px,
          dash: `${6 * px} ${4 * px}`, opacity: 1 });
      }
    }

    // Live quantity next to the cursor (with the scale at that spot)
    const points = [...(progress?.points ?? []), ...(hover ? [hover.point] : [])];
    if (cursor && points.length > 0) {
      const text = live.kind === 'count' && !s.continuingTemplate
        ? s.liveCountText(this.pageIndex())
        : s.liveText(points, live.kind, this.pageIndex());
      const w = (text.length * 7.2 + 10) * px;
      const bx = cursor.x + 14 * px, by = cursor.y - 26 * px;
      shapes.push({ d: rectPath({ x: bx, y: by, w, h: 18 * px }), fill: color, fillOpacity: 0.85, stroke: 'none',
        width: 0, opacity: 1 });
      shapes.push({ text, x: bx + 5 * px, y: by + 9 * px, fill: '#FFFFFF', stroke: 'none', width: 0, opacity: 1,
        fontSize: 12 * px, fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: '600', anchor: 'start',
        baseline: 'middle' });
    }
    return shapes;
  });

  // Search results on this page (the one picked in the panel is stronger)
  readonly searchShapes = computed<Shape[]>(() => {
    const g = this.geometry();
    const focused = this.search.focused();
    if (!g) return [];
    const px = 1 / this.zoom();
    const shapes: Shape[] = [];
    for (const hit of this.search.results()) {
      if (hit.pageIndex !== this.pageIndex()) continue;
      const strong = hit === focused;
      for (const rect of hit.rects) {
        const r = g.rectToView(rect);
        shapes.push({ d: rectPath({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }), fill: COLORS.orange,
          fillOpacity: strong ? 0.5 : 0.25, stroke: strong ? COLORS.red : 'none', width: strong ? 2 * px : 0,
          opacity: 1, blend: 'multiply' });
      }
    }
    return shapes;
  });

  // Markup being drawn (drag, freehand or clicks), drawn exactly as it will look
  private readonly markupPath = signal<Pt[] | null>(null);
  readonly markupPreview = computed<Shape[]>(() => {
    this.markups.styleVersion();
    const kind = this.markups.tool();
    const g = this.geometry();
    if (!kind || !g) return [];
    const px = 1 / this.zoom();
    const hover = this.hover();
    let path = this.markupPath();
    const clicks = this.markups.clicks();
    if (!path && clicks && clicks.pageIndex === this.pageIndex()) {
      path = [...clicks.points, ...(hover ? [hover.point] : [])];
    }
    const shapes: Shape[] = [];
    if (path) {
      const m = this.markups.build(kind, this.pageIndex(), path, g);
      if (m) markupShapes(m, g, shapes);
      // Dots on the clicks of a polyline or polygon
      for (const p of clicks?.points ?? []) {
        shapes.push({ d: circle(g.toView(p), 3 * px), fill: COLORS.blue, stroke: 'none', width: 0, opacity: 1 });
      }
    }
    if (hover?.snapped) {
      const c = g.toView(hover.point);
      shapes.push({ d: rectPath({ x: c.x - 6 * px, y: c.y - 6 * px, w: 12 * px, h: 12 * px }),
        fill: 'none', stroke: COLORS.green, width: 2 * px, opacity: 1 });
    }
    return shapes;
  });

  // Inline editor of a text box: where it goes on screen and how big its text is
  readonly editor = computed(() => {
    this.store.watch();
    this.store.geometry();
    const m = this.markups.editing();
    const g = this.geometry();
    if (!m || !g || m.pageIndex !== this.pageIndex() || this.store.activePane !== this.pane()) return null;
    const z = this.zoom();
    const r = g.rectToView(m.textRect);
    return {
      markup: m,
      box: { x: this.ox() + r.x * z, y: this.oy() + r.y * z, w: Math.max(r.w * z, 60), h: Math.max(r.h * z, 20) },
      fontSize: m.fontSize * z,
      padding: 4 * z,
      color: m.textColor ?? COLORS.black,
    };
  });

  // Mouse drag in progress
  private drag: {
    mode: DragMode;
    startScreen: Pt;                     // client coordinates
    lastScreen: Pt;
    startView: Pt;                       // view coordinates
    lastPage: Pt;                        // page coordinates
    started: boolean;
    additive: boolean;
  } | null = null;

  // Rendering
  private renderTasks: RenderTask[] = [];
  private detailTimer: ReturnType<typeof setTimeout> | undefined;
  private renderedDetail: { pageIndex: number; region: Rect; scale: number } | null = null;
  private fittedPage: unknown = null;          // geometry of the page that was fitted last
  private autoFit = true;                      // the page follows the pane size until the user zooms or pans
  private lastClick: { time: number; x: number; y: number } | null = null;
  private resizeObserver?: ResizeObserver;
  private readonly removeListeners: (() => void)[] = [];

  constructor() {
    // Register with the model so the ribbon and the status bar can zoom this pane
    effect(() => {
      const pane = this.pane();
      untracked(() => this.store.registerPane(pane, {
        zoomBy: f => this.zoomAt(f, { x: this.size().w / 2, y: this.size().h / 2 }),
        fitPage: () => this.fitPage(),
        fitWidth: () => this.fitWidth(),
        showRect: r => this.showRect(r),
      }));
    });

    // New page: fit it to the pane and draw it
    effect(() => {
      const g = this.geometry();
      const size = this.size();
      if (!g || size.w === 0) return;
      untracked(() => {
        if (this.fittedPage === g) {
          // Same page, new pane size: a page that was fitted stays fitted
          if (this.autoFit) this.fitPage();
          return;
        }
        this.fittedPage = g;
        this.renderedDetail = null;
        this.fitPage();
        // The canvases exist after this change detection pass
        setTimeout(() => {
          const detail = this.detailCanvas()?.nativeElement;
          if (detail) detail.width = 0;                 // the old page's sharp part goes away
          this.renderBackground();
        }, 0);
      });
    });

    // Zoom or scroll: draw the visible part sharp (when it stops for a moment)
    effect(() => {
      this.zoom(); this.ox(); this.oy(); this.size();
      if (!this.geometry()) return;
      clearTimeout(this.detailTimer);
      this.detailTimer = setTimeout(() => this.renderDetail(), 120);
    });

    // Overlay: draws the page on top once (again when it changes)
    effect(() => {
      const source = this.overlaySource();
      if (!source) { this.overlayDrawn = null; return; }
      const canvas = this.overlayCanvas()?.nativeElement;
      if (!canvas || (this.overlayDrawn?.canvas === canvas && this.overlayDrawn.source === source)) return;
      this.overlayDrawn = { canvas, source };
      const scale = Math.min(4000 / Math.max(source.width, source.height), 3);
      renderRegion(source.page, { x: 0, y: 0, w: source.width, h: source.height }, scale).then(result => {
        if (!result || this.overlayDrawn?.source !== source) return;
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d')?.drawImage(result, 0, 0);
      });
    });

    // Leaving paste mode removes the picture under the cursor
    effect(() => {
      if (this.store.watch().snapshotMode !== 'place') untracked(() => this.ghost.set(null));
    });

    // A word picked in the OCR panel: center it when its page is shown in the active pane
    let shownFocus: unknown = null;
    effect(() => {
      const focus = this.ocr.focus();
      const g = this.geometry();
      if (!focus || focus === shownFocus || focus.page !== g || this.size().w === 0) return;
      if (untracked(() => this.store.activePane) !== this.pane()) return;
      shownFocus = focus;
      untracked(() => this.showRect(g.rectToPage(focus.view)));
    });

    // Snap points are read in the background when Snap is on
    effect(() => {
      const s = this.store.watch();
      if (s.snapEnabled && s.tool !== 'none') s.snapIndex(this.pageIndex());
    });

    // Search result picked in the panel: zoom to it (only the active pane)
    effect(() => {
      const request = this.search.focusRequest();
      if (!request) return;
      untracked(() => {
        if (this.store.activePane !== this.pane()) return;
        setTimeout(() => this.focusRect(request.rect), 80);
      });
    });

    // Text box editor opened: put the cursor in it
    effect(() => {
      const field = this.editorField()?.nativeElement;
      if (field) setTimeout(() => { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }, 0);
    });

    afterNextRender(() => {
      const host = this.host().nativeElement;
      this.resizeObserver = new ResizeObserver(entries => {
        const r = entries[0].contentRect;
        this.size.set({ w: r.width, h: r.height });
      });
      this.resizeObserver.observe(host);
      // Wheel = zoom (needs passive: false to keep the page from scrolling)
      const wheel = (e: WheelEvent) => this.onWheel(e);
      host.addEventListener('wheel', wheel, { passive: false });
      this.removeListeners.push(() => host.removeEventListener('wheel', wheel));
      const key = (e: KeyboardEvent) => this.onKey(e);
      document.addEventListener('keydown', key);
      this.removeListeners.push(() => document.removeEventListener('keydown', key));
    });
  }

  ngOnDestroy(): void {
    this.store.registerPane(this.pane(), null);
    this.resizeObserver?.disconnect();
    this.removeListeners.forEach(remove => remove());
    this.renderTasks.forEach(t => t.cancel());
    clearTimeout(this.detailTimer);
  }

  // MARK: - Coordinates
  private screenPoint(e: MouseEvent): Pt {
    const r = this.host().nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private viewPoint(screen: Pt): Pt {
    return { x: (screen.x - this.ox()) / this.zoom(), y: (screen.y - this.oy()) / this.zoom() };
  }

  private pagePoint(e: MouseEvent): Pt | null {
    const g = this.geometry();
    return g ? g.toPage(this.viewPoint(this.screenPoint(e))) : null;
  }

  // MARK: - Zoom and fit
  private zoomAt(factor: number, screen: Pt): void {
    const z = this.zoom();
    const next = Math.min(Math.max(z * factor, MIN_ZOOM), MAX_ZOOM);
    this.autoFit = false;
    // Zooms without moving the point under the cursor
    this.ox.set(screen.x - (screen.x - this.ox()) * (next / z));
    this.oy.set(screen.y - (screen.y - this.oy()) * (next / z));
    this.zoom.set(next);
  }

  fitPage(): void {
    const g = this.geometry();
    const { w, h } = this.size();
    if (!g || w === 0) return;
    const z = Math.max(Math.min((w - 24) / g.width, (h - 24) / g.height), MIN_ZOOM);
    this.autoFit = true;
    this.zoom.set(z);
    this.ox.set((w - g.width * z) / 2);
    this.oy.set((h - g.height * z) / 2);
  }

  fitWidth(): void {
    const g = this.geometry();
    const { w } = this.size();
    if (!g || w === 0) return;
    const z = Math.max((w - 24) / g.width, MIN_ZOOM);
    this.autoFit = false;
    this.zoom.set(z);
    this.ox.set(12);
    this.oy.set(12);
  }

  // Centers a region of the page (page coordinates) without changing the zoom
  showRect(rect: Rect): void {
    const g = this.geometry();
    if (!g) return;
    const r = g.rectToView(rect);
    const { w, h } = this.size();
    this.autoFit = false;
    this.ox.set(w / 2 - (r.x + r.w / 2) * this.zoom());
    this.oy.set(h / 2 - (r.y + r.h / 2) * this.zoom());
  }

  // Zooms to a region (a search result) so it can be read, and centers it
  private focusRect(rect: Rect): void {
    const g = this.geometry();
    const { w, h } = this.size();
    if (!g || w === 0) return;
    const r = g.rectToView(rect);
    const fits = Math.min(w * 0.9 / Math.max(r.w, 1), h * 0.9 / Math.max(r.h, 1));
    // Text about 30 px tall on screen, never zoomed out unless the region doesn't fit
    const readable = Math.min(30 / Math.max(Math.min(r.w, r.h), 1), MAX_ZOOM);
    const z = Math.min(Math.max(this.zoom(), readable), fits, MAX_ZOOM);
    this.autoFit = false;
    this.zoom.set(z);
    this.ox.set(w / 2 - (r.x + r.w / 2) * z);
    this.oy.set(h / 2 - (r.y + r.h / 2) * z);
  }

  // MARK: - Mouse
  onWheel(e: WheelEvent): void {
    if (!this.geometry()) return;
    e.preventDefault();
    this.store.activate(this.pane());
    const screen = this.screenPoint(e);
    // Mouse wheel: zoom at the cursor. Pinch (ctrlKey) or ⌘ + scroll: zoom.
    // Only a Mac trackpad (two fingers) moves the plan; on Windows the wheel always zooms.
    const isMac = /Mac/i.test(navigator.platform);
    const isTrackpad = isMac && e.deltaMode === 0
      && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 16);
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(Math.exp(-e.deltaY * 0.01), screen);
    } else if (isTrackpad) {
      this.autoFit = false;
      this.ox.update(v => v - e.deltaX);
      this.oy.update(v => v - e.deltaY);
    } else if (e.deltaY !== 0) {
      this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, screen);
    }
    this.refreshHover(e);
  }

  onHover(e: MouseEvent): void {
    if (this.drag) return;
    if (this.store.snapshotMode === 'place') this.ghost.set(this.viewPoint(this.screenPoint(e)));
    this.refreshHover(e);
  }

  private refreshHover(e: MouseEvent): void {
    const s = this.store;
    if (s.tool === 'none' && !this.markups.tool()) {
      if (this.hover()) this.hover.set(null);
      return;
    }
    const p = this.pagePoint(e);
    this.hover.set(p ? this.snap(p, e) : null);
  }

  // Snap, then Ortho: the point goes to the nearest vertex (Snap) and, with Ortho on or Shift held,
  // in a straight horizontal or vertical line from the previous point (as seen on screen)
  private snap(point: Pt, e?: MouseEvent): { point: Pt; snapped: boolean } {
    const target = this.snapToVertex(point);
    const s = this.store;
    if (!(s.orthoEnabled || e?.shiftKey) || this.markups.isFreehand) return target;
    const anchor = this.orthoAnchor();
    const g = this.geometry();
    if (!anchor || !g) return target;
    const a = g.toView(anchor), p = g.toView(target.point);
    const straight = Math.abs(p.x - a.x) >= Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y };
    return { point: g.toPage(straight), snapped: target.snapped };
  }

  // Point the next one lines up with: previous click of the measurement or markup, or where the drag started
  private orthoAnchor(): Pt | null {
    const s = this.store;
    const page = this.pageIndex();
    if (s.tool !== 'none') {
      const last = s.lastMeasuredPoint;
      return last && last.pageIndex === page ? last.point : null;
    }
    if (this.drag?.mode === 'markup') return this.markupPath()?.[0] ?? null;
    const clicks = this.markups.clicks();
    if (clicks && clicks.pageIndex === page && clicks.points.length) return clicks.points[clicks.points.length - 1];
    return null;
  }

  // Moves a point to the nearest vertex (drawing lines, markups, measurements)
  // within 12 screen pixels. Only while a measuring tool is active.
  private snapToVertex(point: Pt): { point: Pt; snapped: boolean } {
    const s = this.store;
    if (!s.snapEnabled || (s.tool === 'none' && !this.markups.tool()) || this.markups.isFreehand) return { point, snapped: false };
    const radius = 12 / Math.max(this.zoom(), 0.01);
    let best: Pt | null = null;
    let bestDistance = radius;
    const check = (p: Pt) => {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d <= bestDistance) { bestDistance = d; best = p; }
    };
    // Vertices of markups and measurements on this page
    for (const el of s.elementsOn(this.pageIndex())) {
      if (!el.visible) continue;
      if (el instanceof Measurement) el.points.forEach(check);
      else el.vertices?.forEach(check);
    }
    // Vertices of the drawing itself (only a closer one wins)
    const fromDrawing = s.snapIndex(this.pageIndex())?.nearest(point, bestDistance);
    if (fromDrawing) best = fromDrawing;
    return best ? { point: best, snapped: true } : { point, snapped: false };
  }

  onMouseDown(e: MouseEvent): void {
    const s = this.store;
    s.activate(this.pane());
    // Take the focus from any text field, so Enter / Delete reach the plan
    (document.activeElement as HTMLElement | null)?.blur?.();
    const g = this.geometry();
    if (!g) return;
    const screen = this.screenPoint(e);
    const view = this.viewPoint(screen);
    const page = g.toPage(view);
    const start = (mode: DragMode) => this.startDrag(mode, e, screen, view, page);

    // Middle button pressed + drag = move the plan (works with any tool)
    if (e.button === 1) {
      e.preventDefault();
      return start('pan');
    }
    if (e.button !== 0) return;
    e.preventDefault();

    // Viewport: start its box
    if (s.drawingViewport) return start('viewport');

    // Markup tools: clicks for a polyline or polygon (double click finishes), a drag for the rest
    if (this.markups.tool() && s.tool === 'none') {
      const target = this.snap(page, e);
      if (this.markups.isClickTool) {
        const now = performance.now();
        const last = this.lastClick;
        const isDouble = !!last && now - last.time < 400 && Math.hypot(screen.x - last.x, screen.y - last.y) < 5;
        this.lastClick = isDouble ? null : { time: now, x: screen.x, y: screen.y };
        if (isDouble) this.markups.finishClicks(g);
        else this.markups.addClick(target.point, this.pageIndex());
        this.hover.set(target);
        return;
      }
      this.markupPath.set([target.point]);
      return start('markup');
    }
    // OCR region: start its box
    if (this.ocr.drawingRegion()) return start('ocr');

    // Snapshot: drag the region to copy, or click to drop the copied picture
    if (s.snapshotMode === 'capture') return start('snapshot');
    // Create Page Labels: the box around the page name
    if (this.labeler.selecting()) return start('labels');
    if (s.snapshotMode === 'place') {
      const clip = s.snapshotClip;
      if (clip) s.placeSnapshot(this.pageIndex(), g.rectToPage({ x: view.x - clip.w / 2, y: view.y - clip.h / 2, w: clip.w, h: clip.h }));
      return;
    }

    // Overlay "Move": dragging moves the page on top
    if (this.overlayHere()?.adjusting) return start('overlay');

    // Measuring: every click adds a point (snapped if Snap is on); double click closes it.
    // A double click is a second click on the same spot within 0.4 s
    if (s.tool !== 'none') {
      const target = this.snap(page, e);
      const now = performance.now();
      const last = this.lastClick;
      const isDouble = !!last && now - last.time < 400 && Math.hypot(screen.x - last.x, screen.y - last.y) < 5;
      this.lastClick = isDouble ? null : { time: now, x: screen.x, y: screen.y };
      if (isDouble) s.finishCurrentMeasurement();
      else s.addPoint(target.point, this.pageIndex());
      this.hover.set(target);
      return;
    }

    // Shift or ⌘ + click = add to / remove from the selection
    const additive = e.shiftKey || e.metaKey;
    const element = s.elementAt(this.pageIndex(), page, 3 / this.zoom() + 3);

    // If the element was already selected (no Shift) the selection stays, so a whole group can be dragged
    const selectElement = (el: PlanElement) => {
      if (additive || !s.isSelected(el)) s.selectFromPlan([el], additive);
      // Holding the click on something selected = it can be dragged
      if (s.isSelected(el)) start('move');
    };

    switch (s.interaction) {
      case 'pan':
        // Click on an element selects it (and it can be dragged); on an empty area it deselects
        // and dragging moves the plan
        if (element) selectElement(element);
        else {
          if (!additive && s.selection.length) s.selectElements([]);
          start('pan');
        }
        break;
      case 'select':
        if (element) selectElement(element);
        else {
          if (!additive && s.selection.length) s.selectElements([]);
          start('marquee');
        }
        break;
      case 'zoom':
        // Click = zoom in, ⌥ + click = zoom out
        this.zoomAt(e.altKey ? 0.8 : 1.25, screen);
        break;
    }
  }

  private startDrag(mode: DragMode, e: MouseEvent, screen: Pt, view: Pt, page: Pt): void {
    this.drag = {
      mode, startScreen: { x: e.clientX, y: e.clientY }, lastScreen: { x: e.clientX, y: e.clientY },
      startView: view, lastPage: page, started: false, additive: e.shiftKey || e.metaKey,
    };
    if (mode === 'pan') this.panning.set(true);
    const move = (ev: MouseEvent) => this.onDragMove(ev);
    const up = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this.onDragEnd(ev);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private onDragMove(e: MouseEvent): void {
    const d = this.drag;
    const g = this.geometry();
    if (!d || !g) return;
    const dx = e.clientX - d.lastScreen.x, dy = e.clientY - d.lastScreen.y;
    // Markup being drawn: freehand tools keep every point, the others only the last one
    if (d.mode === 'markup') {
      const point = this.snap(g.toPage(this.viewPoint(this.screenPoint(e))), e);
      this.hover.set(point);
      const path = this.markupPath() ?? [];
      if (this.markups.isFreehand) {
        const last = path[path.length - 1];
        if (!last || Math.hypot(point.point.x - last.x, point.point.y - last.y) * this.zoom() > 1.5) {
          this.markupPath.set([...path, point.point]);
        }
      } else {
        this.markupPath.set([path[0] ?? point.point, point.point]);
      }
      return;
    }
    // 2 px threshold on screen so a click doesn't move things by accident
    if (!d.started && Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) < 2) return;
    d.started = true;
    d.lastScreen = { x: e.clientX, y: e.clientY };
    const view = this.viewPoint(this.screenPoint(e));

    switch (d.mode) {
      case 'pan':
        this.autoFit = false;
        this.ox.update(v => v + dx);
        this.oy.update(v => v + dy);
        break;
      case 'move': {
        const page = g.toPage(view);
        this.store.moveSelected(page.x - d.lastPage.x, page.y - d.lastPage.y);
        d.lastPage = page;
        break;
      }
      case 'marquee':
      case 'viewport':
      case 'snapshot':
      case 'ocr':
      case 'labels':
        this.marquee.set(rectFromPoints(d.startView, view));
        break;
      case 'overlay': {
        const o = this.store.overlay();
        if (o) this.store.updateOverlay({ dx: o.dx + dx / this.zoom(), dy: o.dy + dy / this.zoom() });
        break;
      }
    }
  }

  private onDragEnd(e: MouseEvent): void {
    const d = this.drag;
    const g = this.geometry();
    this.drag = null;
    this.panning.set(false);
    const box = this.marquee();
    this.marquee.set(null);
    if (!d || !g) return;
    const s = this.store;

    switch (d.mode) {
      case 'markup': {
        const path = this.markupPath();
        const kind = this.markups.tool();
        this.markupPath.set(null);
        if (!path || !kind) break;
        const m = this.markups.build(kind, this.pageIndex(), path, g);
        if (m) this.markups.add(m);
        break;
      }
      case 'move':
        if (d.started) s.finishMove();
        break;
      case 'viewport':
        // Mouse up on a viewport box: hand it to the model
        if (box && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) s.finishViewport(g.rectToPage(box), this.pageIndex());
        else s.cancelViewport();
        break;
      case 'labels':
        // Mouse up on the page-label box: read it and go back to the dialog
        if (box && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) {
          void this.labeler.finishSelecting(this.pageIndex(), clip(box, g.width, g.height));
        } else this.labeler.cancelSelecting();
        break;
      case 'snapshot': {
        // Mouse up on the snapshot box: copy that region
        if (box && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) {
          const region = clip(box, g.width, g.height);
          const index = this.pageIndex();
          captureSnapshot(s, index, g, region).then(result => {
            if (result) s.setSnapshotClip(result); else s.showToast("Couldn't copy that region", true);
          });
        }
        break;
      }
      case 'ocr':
        // Mouse up on the OCR box: read the text inside it
        if (box && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) this.ocr.finishRegion(this.pageIndex(), box);
        else this.ocr.cancelRegion();
        break;
      case 'marquee':
        // Mouse up on the selection box: select everything it touches
        if (box && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) {
          const rect = g.rectToPage(box);
          const found = s.elementsOn(this.pageIndex()).filter(el => el.visible && rectsIntersect(el.bounds, rect));
          s.selectFromPlan(found, d.additive || e.shiftKey || e.metaKey);
        }
        break;
    }
  }

  // MARK: - Keys (only the active pane answers)
  private onKey(e: KeyboardEvent): void {
    const s = this.store;
    if (s.activePane !== this.pane() || !this.geometry() || s.scaleRequest) return;
    // While typing in a text field (rename, search) we leave the key alone
    const target = e.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;

    // Snapshot: Ctrl+V / ⌘V pastes the copied region, Esc leaves the tool
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && s.snapshotClip) {
      e.preventDefault();
      s.pasteSnapshot();
      return;
    }
    if (s.snapshotMode !== 'none' && e.key === 'Escape') {
      this.marquee.set(null);
      s.cancelSnapshot();
      return;
    }
    // Overlay "Move": arrows nudge the page on top (Shift = 10 times more)
    const o = this.overlayHere();
    if (o?.adjusting && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / Math.max(this.zoom(), 0.01);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      s.updateOverlay({ dx: o.dx + dx, dy: o.dy + dy });
      return;
    }

    // OCR region: Esc cancels it
    if (this.labeler.selecting() && e.key === 'Escape') {
      this.marquee.set(null);
      this.labeler.cancelSelecting();
      return;
    }
    if (this.ocr.drawingRegion() && e.key === 'Escape') {
      this.marquee.set(null);
      this.ocr.cancelRegion();
      return;
    }
    // Markup tools: Enter finishes a polyline / polygon, Esc leaves the tool
    if (this.markups.tool() && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      if (e.key === 'Enter' && this.markups.clicks()) this.markups.finishClicks(this.geometry());
      else this.markups.cancel();
      this.markupPath.set(null);
      this.hover.set(null);
      return;
    }
    // Measuring: Enter / Return and Esc finish the measurement and leave the tool
    if (s.tool !== 'none' && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      s.cancelTool();
      this.hover.set(null);
    } else if (s.drawingViewport && e.key === 'Escape') {
      // Drawing a viewport: Esc cancels it
      this.marquee.set(null);
      s.cancelViewport();
    } else if (s.tool === 'none' && (e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) {
      // Not measuring: Delete removes the selection, Esc deselects
      e.preventDefault();
      s.deleteSelected();
    } else if (s.tool === 'none' && e.key === 'Escape' && s.selection.length) {
      s.selectElements([]);
    }
  }

  // Double click on a text box or callout: edit its text
  onDoubleClick(e: MouseEvent): void {
    const s = this.store;
    if (s.tool !== 'none' || this.markups.tool()) return;
    const page = this.pagePoint(e);
    if (!page) return;
    const el = s.elementAt(this.pageIndex(), page, 3 / this.zoom() + 3);
    if (el instanceof Markup && el.isTextBox) this.markups.startEditing(el);
  }

  // Editor keys: Esc or ⌘/Ctrl + Enter close it (Enter alone is a new line)
  editorKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      (e.target as HTMLTextAreaElement).blur();
    }
  }

  commitEditor(e: FocusEvent): void {
    const ed = this.editor();
    if (ed) this.markups.commitText(ed.markup, (e.target as HTMLTextAreaElement).value, this.geometry());
  }

  // MARK: - Drawing the page
  // Whole page at low resolution: shown right away and while the sharp part is drawn
  private async renderBackground(): Promise<void> {
    const g = this.geometry();
    const canvas = this.backgroundCanvas()?.nativeElement;
    if (!g || !canvas) return;
    const index = this.pageIndex();
    const scale = Math.min(3000 / Math.max(g.width, g.height), 2);
    const result = await renderRegion(g.page, { x: 0, y: 0, w: g.width, h: g.height }, scale,
      t => this.renderTasks.push(t));
    if (!result || index !== this.pageIndex()) return;
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext('2d')?.drawImage(result, 0, 0);
  }

  // The visible part of the page (plus a margin) at the screen resolution
  private async renderDetail(): Promise<void> {
    const g = this.geometry();
    const canvas = this.detailCanvas()?.nativeElement;
    const { w, h } = this.size();
    if (!g || !canvas || w === 0) return;
    const z = this.zoom();
    const index = this.pageIndex();
    let scale = z * (window.devicePixelRatio || 1);

    // Visible region in view coordinates, grown by 25 % on each side, inside the page
    const visible = { x: -this.ox() / z, y: -this.oy() / z, w: w / z, h: h / z };
    const grow = (r: Rect, f: number): Rect => clip({ x: r.x - r.w * f, y: r.y - r.h * f, w: r.w * (1 + 2 * f), h: r.h * (1 + 2 * f) },
      g.width, g.height);
    let region = grow(visible, 0.25);
    if (region.w <= 0 || region.h <= 0) return;
    if (region.w * region.h * scale * scale > MAX_CANVAS_PIXELS) region = grow(visible, 0);
    if (region.w * region.h * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (region.w * region.h));

    // Already drawn at this resolution
    const done = this.renderedDetail;
    if (done && done.pageIndex === index && Math.abs(done.scale - scale) < 1e-6 && contains(done.region, clip(visible, g.width, g.height))) return;

    this.renderTasks.forEach(t => t.cancel());
    this.renderTasks = [];
    const result = await renderRegion(g.page, region, scale, t => this.renderTasks.push(t));
    if (!result || index !== this.pageIndex()) return;
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext('2d')?.drawImage(result, 0, 0);
    canvas.style.left = `${region.x}px`;
    canvas.style.top = `${region.y}px`;
    canvas.style.width = `${region.w}px`;
    canvas.style.height = `${region.h}px`;
    this.renderedDetail = { pageIndex: index, region, scale };
  }
}


function circle(c: Pt, r: number): string {
  return `M${c.x - r} ${c.y} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

function clip(r: Rect, width: number, height: number): Rect {
  const x = Math.max(r.x, 0), y = Math.max(r.y, 0);
  return { x, y, w: Math.min(r.x + r.w, width) - x, h: Math.min(r.y + r.h, height) - y };
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
    && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
}
