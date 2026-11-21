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
import { Shape, TEXT_FONT, VERTEX_HANDLE, markupShapes, pageShapes, pathOf, rectPath, viewportShapes } from '../../services/shapes/shapes';
import { TextSearch } from '../../services/text-search/text-search';
import { TextSelect } from '../../services/text-select/text-select';
import { CalcTools } from '../../services/calc-tools/calc-tools';
import { CutoutTool } from '../../services/cutout-tool/cutout-tool';
import { JoistTool } from '../../services/joist-tool/joist-tool';
import { JoistPanel } from '../joist-panel/joist-panel';
import { OverlayPanel } from '../overlay-panel/overlay-panel';
import { SvgShapes } from '../svg-shapes/svg-shapes';

const MIN_ZOOM = 0.05;
type DragMode = 'pan' | 'move' | 'vertex' | 'marquee' | 'viewport' | 'ocr' | 'snapshot' | 'overlay' | 'overlayScale' | 'overlayRotate'
  | 'markup' | 'labels' | 'text';
const MAX_ZOOM = 40;
const MAX_CANVAS_PIXELS = 16_000_000;     // Safari's canvas limit is about 16.7 M pixels

// One plan pane (port of MeasurementPDFView, PDFContainerView, LivePreviewView and DrawingView):
// the page drawn by pdf.js on canvases, and an SVG layer on top with the markups,
// the measurements, the selection and the measurement in progress.
@Component({
  selector: 'app-plan-view',
  imports: [JoistPanel, OverlayPanel, SvgShapes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .markup-editor { position: absolute; z-index: 5; box-sizing: border-box; resize: none; overflow: hidden; line-height: 1.2;
      background: rgba(255, 255, 255, 0.92); border: 1px dashed #007aff; border-radius: 0; outline: none; white-space: pre-wrap; }
    .tint-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
    .overlay-canvas { transform-origin: 50% 50%; pointer-events: none; }
    .text-copy-button { position: absolute; z-index: 5; padding: 2px 10px; font-size: 12px; border-radius: 6px;
      background: #007aff; color: #fff; border: none; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); cursor: pointer; }
  `],
  template: `
    <div #host class="plan-host" [style.cursor]="cursor()"
         (mousedown)="onMouseDown($event)" (mousemove)="onHover($event)" (mouseleave)="hover.set(null); lastMousePage = null"
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
            <g [appShapes]="textShapes()"></g>
            <g [appShapes]="calcShapes()"></g>
            <g [appShapes]="cutoutShapes()"></g>
            <g [appShapes]="joistShapes()"></g>
            <g [appShapes]="liveShapes()"></g>
            <g [appShapes]="markupPreview()"></g>
            <g [appShapes]="overlayHandles()"></g>
          </svg>
        </div>
        <!-- Pitch measured on the plan: apply it to roof areas and lines -->
        @if (pitchButton(); as b) {
          <button type="button" class="text-copy-button" [style.left.px]="b.x" [style.top.px]="b.y"
                  title="Apply this pitch to areas and lines" (mousedown)="$event.stopPropagation()"
                  (click)="store.openPitch(b.pitch)">Apply {{ b.pitch }}/12…</button>
        }
        <!-- Select Text: copy button next to the selected text -->
        @if (copyButton(); as c) {
          <button type="button" class="text-copy-button" [style.left.px]="c.x" [style.top.px]="c.y"
                  title="Copy the selected text (Ctrl+C)" (mousedown)="$event.stopPropagation()" (click)="textSelect.copy()">
            Copy
          </button>
        }
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
        @if (showJoistPanel()) { <app-joist-panel /> }
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
  readonly textSelect = inject(TextSelect);
  readonly calc = inject(CalcTools);
  readonly cutout = inject(CutoutTool);
  readonly joist = inject(JoistTool);
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

  // Document shown in this view: the active one, or another open document (drawn only;
  // a click makes it the active one)
  readonly doc = computed(() => this.store.watch().docView(this.pane()), { equal: () => false });
  readonly foreign = computed(() => this.doc() !== this.store);   // (a plain boolean: changes only when it flips)
  readonly pageIndex = computed(() => this.doc().pageIndexes[this.pane()]);
  readonly geometry = computed(() => this.doc().pages[this.pageIndex()] ?? null);
  // Page for the tools and live layers: none while the view shows another document
  private readonly liveGeometry = computed(() => this.foreign() ? null : this.geometry());

  // Overlay drawn on this pane (only on its base page) and the page on top
  readonly overlayHere = computed<OverlayState | null>(() => {
    const o = this.store.overlay();
    return o && !this.foreign() && o.baseIndex === this.pageIndex() ? o : null;
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
  // The Joist Tool panel goes in the active pane
  readonly showJoistPanel = computed(() => {
    const s = this.store.watch();
    return this.joist.open() && !this.foreign() && s.activePane === this.pane();
  });
  private readonly overlayCanvas = viewChild<ElementRef<HTMLCanvasElement>>('overlayCanvas');
  private overlayDrawn: { canvas: HTMLCanvasElement; source: PageGeometry } | null = null;
  // Snapshot being pasted: center of the picture under the cursor (view coordinates)
  private readonly ghost = signal<Pt | null>(null);

  // Corners of the page on top as drawn on the base page (view coordinates): TL, TR, BR, BL,
  // its center, and the rotation handle above the top edge
  private overlayFrame(): { corners: Pt[]; center: Pt; rotate: Pt } | null {
    const o = this.overlayHere(), src = this.overlaySource();
    if (!o || !src || !o.adjusting) return null;
    const a = o.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const center = { x: src.width / 2 + o.dx, y: src.height / 2 + o.dy };
    const place = (x: number, y: number): Pt => {
      const vx = (x - src.width / 2) * o.scale, vy = (y - src.height / 2) * o.scale;
      return { x: center.x + vx * cos - vy * sin, y: center.y + vx * sin + vy * cos };
    };
    const corners = [place(0, 0), place(src.width, 0), place(src.width, src.height), place(0, src.height)];
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const len = Math.hypot(topMid.x - center.x, topMid.y - center.y) || 1;
    const out = 28 / this.zoom();
    const rotate = { x: topMid.x + (topMid.x - center.x) / len * out, y: topMid.y + (topMid.y - center.y) / len * out };
    return { corners, center, rotate };
  }

  // Frame and handles of the page on top while Move is on (corners scale, the round handle rotates)
  readonly overlayHandles = computed<Shape[]>(() => {
    this.store.watch();
    const f = this.overlayFrame();
    if (!f) return [];
    const px = 1 / this.zoom(), color = COLORS.blue;
    const [a, b, c, d] = f.corners;
    const shapes: Shape[] = [{
      d: `M${a.x} ${a.y}L${b.x} ${b.y}L${c.x} ${c.y}L${d.x} ${d.y}Z`, fill: 'none', stroke: color, width: 1.5 * px,
      dash: `${6 * px} ${4 * px}`, opacity: 1,
    }];
    const topMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    shapes.push({ d: `M${topMid.x} ${topMid.y}L${f.rotate.x} ${f.rotate.y}`, fill: 'none', stroke: color, width: 1.5 * px, opacity: 1 });
    const h = 5 * px;
    for (const p of f.corners) {
      shapes.push({ d: rectPath({ x: p.x - h, y: p.y - h, w: 2 * h, h: 2 * h }), fill: '#ffffff', stroke: color, width: 1.5 * px, opacity: 1 });
    }
    const r = 6 * px;
    shapes.push({
      d: `M${f.rotate.x - r} ${f.rotate.y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`,
      fill: '#ffffff', stroke: color, width: 1.5 * px, opacity: 1,
    });
    return shapes;
  });

  // Values when a scale / rotate handle was grabbed
  private overlayGrab: { scale: number; rotation: number; distance: number; angle: number; center: Pt } | null = null;

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
    if (this.textSelect.active()) return 'text';
    if (this.calc.mode() || this.cutout.active() || this.joist.mode()) return 'crosshair';
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
    return g ? pageShapes(this.doc(), this.pageIndex(), g, this.zoom(), !this.foreign()) : [];
  });

  // OCR: recognized words (soft yellow) and the word picked in the OCR panel (orange frame)
  readonly ocrShapes = computed<Shape[]>(() => {
    this.store.watch();
    const g = this.liveGeometry();
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
    const g = this.liveGeometry();
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
    const g = this.liveGeometry();
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

  // Select Text: the selected words on this page
  readonly textShapes = computed<Shape[]>(() => {
    const g = this.liveGeometry();
    const sel = this.textSelect.selection();
    if (!g || !sel || sel.pageIndex !== this.pageIndex()) return [];
    return sel.words.map(w => {
      const r = g.rectToView(w.rect);
      return { d: rectPath({ x: r.x - 0.5, y: r.y, w: r.w + 1, h: r.h }), fill: COLORS.blue, fillOpacity: 0.3,
        stroke: 'none', width: 0, opacity: 1, blend: 'multiply' } as Shape;
    });
  });

  // Pitch lines and triangles measured with the Calculation tools (yellow labels like PlanSwift)
  readonly calcShapes = computed<Shape[]>(() => {
    this.store.watch();
    const g = this.liveGeometry();
    if (!g) return [];
    const px = 1 / this.zoom();
    const shapes: Shape[] = [];
    const red = COLORS.red;
    const label = (at: Pt, text: string) => {
      const w = (text.length * 6.6 + 10) * px, h = 17 * px;
      shapes.push({ d: rectPath({ x: at.x - w / 2, y: at.y - h / 2, w, h }), fill: '#FFF59D', fillOpacity: 0.95,
        stroke: '#B59F00', width: px, opacity: 1 });
      shapes.push({ text, x: at.x, y: at.y, fill: '#0D47A1', stroke: 'none', width: 0, opacity: 1, fontSize: 12 * px,
        fontWeight: '600', anchor: 'middle', baseline: 'middle' });
    };
    const dot = (v: Pt) => shapes.push({ d: circle(v, 3 * px), fill: red, stroke: 'none', width: 0, opacity: 1 });
    const draw = (kind: 'pitch' | 'triangulate', points: Pt[], live: boolean) => {
      const v = points.map(p => g.toView(p));
      const closed = kind === 'triangulate' && points.length === 3 && !live;
      shapes.push({ d: pathOf(v, closed), fill: 'none', stroke: kind === 'pitch' ? COLORS.blue : red, width: 1.5 * px,
        dash: live ? `${6 * px} ${4 * px}` : undefined, opacity: 1 });
      v.forEach(dot);
      if (kind === 'pitch' && points.length === 2) {
        const pitch = this.calc.pitchOf(g, points[0], points[1]);
        label({ x: v[1].x + 50 * px, y: v[1].y - 14 * px }, this.calc.pitchText(pitch));
      }
      if (kind === 'triangulate') {
        const sides = closed ? [[0, 1], [1, 2], [2, 0]] : v.slice(1).map((_, i) => [i, i + 1]);
        for (const [i, j] of sides) {
          label({ x: (v[i].x + v[j].x) / 2, y: (v[i].y + v[j].y) / 2 }, this.calc.lengthText(g, points[i], points[j]));
        }
        if (closed) {
          const cx = (v[0].x + v[1].x + v[2].x) / 3, cy = (v[0].y + v[1].y + v[2].y) / 3;
          for (let k = 0; k < 3; k++) {
            const angle = this.calc.angleAt(points[(k + 2) % 3], points[k], points[(k + 1) % 3]);
            // Inside the corner, a little toward the middle of the triangle
            const d = Math.hypot(cx - v[k].x, cy - v[k].y) || 1;
            const step = Math.min(28 * px, d * 0.45);
            label({ x: v[k].x + (cx - v[k].x) / d * step, y: v[k].y + (cy - v[k].y) / d * step }, `${angle.toFixed(2)}°`);
          }
        }
      }
    };
    for (const item of this.calc.items()) if (item.page === g) draw(item.kind, item.points, false);
    // In progress: the points so far and the line to the cursor
    const now = this.calc.current();
    const mode = this.calc.mode();
    const hover = this.hover();
    if (mode && now && now.page === g) draw(mode, hover ? [...now.points, hover.point] : now.points, true);
    return shapes;
  });

  // Cut Out in progress: the corners so far, the line to the cursor and back to the first corner
  readonly cutoutShapes = computed<Shape[]>(() => {
    const now = this.cutout.current();
    const g = this.liveGeometry();
    if (!this.cutout.active() || !g || !now || now.pageIndex !== this.pageIndex()) return [];
    const px = 1 / Math.max(this.zoom(), 0.01);
    const hover = this.hover();
    const v = now.points.map(p => g.toView(p));
    const shapes: Shape[] = [];
    const red = COLORS.red;
    const all = hover ? [...v, g.toView(hover.point)] : v;
    if (all.length >= 3) shapes.push({ d: pathOf(all, true), fill: '#FFFFFF', fillOpacity: 0.55, stroke: 'none', width: 0, opacity: 1 });
    if (v.length > 1) shapes.push({ d: pathOf(v, false), fill: 'none', stroke: red, width: 2 * px, opacity: 1 });
    if (hover && v.length) {
      const rubber = [v[v.length - 1], g.toView(hover.point)];
      if (v.length > 1) rubber.push(v[0]);
      shapes.push({ d: pathOf(rubber, false), fill: 'none', stroke: red, width: 1.5 * px, dash: `${6 * px} ${4 * px}`, opacity: 1 });
    }
    v.forEach((p, i) => shapes.push({ d: rectPath({ x: p.x - (i ? 3 : 5) * px, y: p.y - (i ? 3 : 5) * px, w: (i ? 6 : 10) * px, h: (i ? 6 : 10) * px }),
      fill: i ? red : '#FFFFFF', stroke: red, width: 1.5 * px, opacity: 1 }));
    return shapes;
  });

  // Joist Tool in progress: the area being drawn, or the direction / split line with its arrow
  readonly joistShapes = computed<Shape[]>(() => {
    const mode = this.joist.mode();
    const now = this.joist.current();
    const g = this.liveGeometry();
    if (!mode || !g || !now || now.pageIndex !== this.pageIndex()) return [];
    const px = 1 / Math.max(this.zoom(), 0.01);
    const hover = this.hover();
    const color = mode === 'split' ? COLORS.red : this.joist.settings().color;
    const v = now.points.map(p => g.toView(p));
    const all = hover ? [...v, g.toView(hover.point)] : v;
    const shapes: Shape[] = [];
    if (mode === 'area') {
      if (all.length >= 3) shapes.push({ d: pathOf(all, true), fill: color, fillOpacity: 0.15, stroke: 'none', width: 0, opacity: 1 });
      if (all.length > 1) shapes.push({ d: pathOf(all, false), fill: 'none', stroke: color, width: 2 * px, opacity: 1 });
    } else if (all.length === 2) {
      const [a, b] = all;
      shapes.push({ d: pathOf(all, false), fill: 'none', stroke: color, width: 2 * px, dash: `${6 * px} ${4 * px}`, opacity: 1 });
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 0 && mode === 'direction') {
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, size = 12 * px;
        const head = [{ x: b.x - ux * size - uy * size * 0.5, y: b.y - uy * size + ux * size * 0.5 }, b,
          { x: b.x - ux * size + uy * size * 0.5, y: b.y - uy * size - ux * size * 0.5 }];
        shapes.push({ d: pathOf(head, false), fill: 'none', stroke: color, width: 2 * px, opacity: 1 });
      }
    }
    v.forEach((p, i) => shapes.push({ d: rectPath({ x: p.x - (i ? 3 : 5) * px, y: p.y - (i ? 3 : 5) * px, w: (i ? 6 : 10) * px, h: (i ? 6 : 10) * px }),
      fill: i ? color : '#FFFFFF', stroke: color, width: 1.5 * px, opacity: 1 }));
    return shapes;
  });

  // "Apply …/12" next to the last pitch measured on this page
  readonly pitchButton = computed<(Pt & { pitch: number }) | null>(() => {
    const g = this.liveGeometry();
    if (!g || !this.calc.mode()) return null;
    const last = [...this.calc.items()].reverse().find(i => i.kind === 'pitch' && i.page === g);
    if (!last) return null;
    const pitch = this.calc.pitchOf(g, last.points[0], last.points[1]);
    if (!isFinite(pitch)) return null;
    const v = g.toView(last.points[1]);
    return { x: this.ox() + v.x * this.zoom() + 8, y: this.oy() + v.y * this.zoom() + 6, pitch: Math.round(pitch * 100) / 100 };
  });

  // Copy button under the last selected word (screen position in the pane)
  readonly copyButton = computed<Pt | null>(() => {
    const g = this.liveGeometry();
    const sel = this.textSelect.selection();
    if (!g || !sel || sel.pageIndex !== this.pageIndex() || !this.textSelect.active()) return null;
    const last = sel.words[sel.words.length - 1];
    if (!last) return null;
    const r = g.rectToView(last.rect);
    return { x: this.ox() + (r.x + r.w) * this.zoom() + 4, y: this.oy() + (r.y + r.h) * this.zoom() + 4 };
  });

  // Markup being drawn (drag, freehand or clicks), drawn exactly as it will look
  private readonly markupPath = signal<Pt[] | null>(null);
  readonly markupPreview = computed<Shape[]>(() => {
    this.markups.styleVersion();
    const kind = this.markups.tool();
    const g = this.liveGeometry();
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
    const g = this.liveGeometry();
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
      renderRegion(source, { x: 0, y: 0, w: source.width, h: source.height }, scale).then(result => {
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

  // Vertex being dragged (a square of the selected line or area)
  private vertexDrag: { el: PlanElement; index: number; begun: boolean } | null = null;

  // Where a dragged vertex goes: the nearest other vertex within 12 px (Snap), and with Ortho or
  // Shift in a straight line from the previous vertex
  private snapVertex(point: Pt, v: { el: PlanElement; index: number }, e: MouseEvent): Pt {
    const s = this.store;
    const own = s.editableVertices(v.el) ?? [];
    let result = point;
    if (s.snapEnabled) {
      let best: Pt | null = null;
      let bestDistance = 12 / Math.max(this.zoom(), 0.01);
      const check = (p: Pt) => {
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d <= bestDistance) { bestDistance = d; best = p; }
      };
      for (const el of s.elementsOn(this.pageIndex())) {
        if (!el.visible) continue;
        const list = el instanceof Measurement ? el.points : el.vertices ?? [];
        list.forEach((p, i) => { if (el !== v.el || i !== v.index) check(p); });
      }
      const fromDrawing = s.snapIndex(this.pageIndex())?.nearest(point, bestDistance);
      result = fromDrawing ?? best ?? point;
    }
    const g = this.geometry();
    const anchor = own[v.index - 1] ?? (own.length > 2 ? own[own.length - 1] : own[1]);
    if ((s.orthoEnabled || e.shiftKey) && g && anchor) {
      const a = g.toView(anchor), p = g.toView(result);
      result = g.toPage(Math.abs(p.x - a.x) >= Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y });
    }
    return result;
  }

  // Where the mouse is on this page (page coordinates), for Paste; null when it left the plan
  lastMousePage: Pt | null = null;

  onHover(e: MouseEvent): void {
    this.lastMousePage = this.pagePoint(e);
    if (this.drag) return;
    if (this.store.snapshotMode === 'place') this.ghost.set(this.viewPoint(this.screenPoint(e)));
    this.refreshHover(e);
  }

  private refreshHover(e: MouseEvent): void {
    const s = this.store;
    if (this.foreign() || (s.tool === 'none' && !this.markups.tool() && !this.calc.mode() && !this.cutout.active() && !this.joist.mode())) {
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
    const calc = this.calc.current();
    if (calc && calc.page === this.geometry()) return calc.points[calc.points.length - 1];
    const hole = this.cutout.current();
    if (hole && hole.pageIndex === page) return hole.points[hole.points.length - 1];
    const joist = this.joist.current();
    if (joist && joist.pageIndex === page) return joist.points[joist.points.length - 1];
    const clicks = this.markups.clicks();
    if (clicks && clicks.pageIndex === page && clicks.points.length) return clicks.points[clicks.points.length - 1];
    return null;
  }

  // Moves a point to the nearest vertex (drawing lines, markups, measurements)
  // within 12 screen pixels. Only while a measuring tool is active.
  private snapToVertex(point: Pt): { point: Pt; snapped: boolean } {
    const s = this.store;
    if (!s.snapEnabled || (s.tool === 'none' && !this.markups.tool() && !this.cutout.active() && !this.joist.mode()) || this.markups.isFreehand) {
      return { point, snapped: false };
    }
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

    // Cut Out: every click adds a corner of the hole; a click on the first corner closes it
    if (this.cutout.active()) {
      const target = this.snap(page, e);
      const now = performance.now();
      const last = this.lastClick;
      const isDouble = !!last && now - last.time < 400 && Math.hypot(screen.x - last.x, screen.y - last.y) < 5;
      this.lastClick = isDouble ? null : { time: now, x: screen.x, y: screen.y };
      if (isDouble) this.cutout.finish();
      else this.cutout.addPoint(this.pageIndex(), target.point, 8 / Math.max(this.zoom(), 0.01));
      this.hover.set(target);
      return;
    }

    // Joist Tool: corners of the area, then the start and end of the joist direction (or of a split line)
    if (this.joist.mode()) {
      const target = this.snap(page, e);
      const now = performance.now();
      const last = this.lastClick;
      const isDouble = !!last && now - last.time < 400 && Math.hypot(screen.x - last.x, screen.y - last.y) < 5;
      this.lastClick = isDouble ? null : { time: now, x: screen.x, y: screen.y };
      if (isDouble && this.joist.mode() === 'area') this.joist.finish();
      else this.joist.addPoint(this.pageIndex(), target.point, 8 / Math.max(this.zoom(), 0.01));
      this.hover.set(target);
      return;
    }

    // Pitch / Triangulate: every click adds a point (with Snap and Ortho)
    if (this.calc.mode()) {
      const target = this.snap(page, e);
      this.calc.addPoint(g, target.point);
      this.hover.set(target);
      return;
    }

    // Select Text: from a word = the words up to the cursor, from an empty spot = a box
    if (this.textSelect.active()) {
      void this.textSelect.begin(this.pageIndex(), page, 2 / this.zoom() + 1);
      return start('text');
    }

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

    // Overlay "Move": a corner scales the page on top, the round handle rotates it, elsewhere moves it
    const overlay = this.overlayHere();
    if (overlay?.adjusting) {
      const f = this.overlayFrame();
      const near = (p: Pt) => Math.hypot(p.x - view.x, p.y - view.y) * this.zoom() < 9;
      if (f && (near(f.rotate) || f.corners.some(near))) {
        this.overlayGrab = {
          scale: overlay.scale, rotation: overlay.rotation, center: f.center,
          distance: Math.hypot(view.x - f.center.x, view.y - f.center.y) || 1,
          angle: Math.atan2(view.y - f.center.y, view.x - f.center.x),
        };
        return start(near(f.rotate) ? 'overlayRotate' : 'overlayScale');
      }
      return start('overlay');
    }

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

    // A square of the selected line or area: drag that vertex
    if (s.interaction !== 'zoom' && s.selection.length === 1 && s.selection[0].pageIndex === this.pageIndex()) {
      const el = s.selection[0];
      const vertices = s.editableVertices(el);
      const reach = (VERTEX_HANDLE / 2 + 2) / this.zoom();
      const index = vertices ? vertices.findIndex(p => {
        const v = g.toView(p);
        return Math.abs(v.x - view.x) <= reach && Math.abs(v.y - view.y) <= reach;
      }) : -1;
      if (index >= 0) {
        this.vertexDrag = { el, index, begun: false };
        return start('vertex');
      }
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
      case 'vertex': {
        const v = this.vertexDrag;
        if (!v) break;
        if (!v.begun) {
          this.store.beginVertexEdit(v.el);              // one Undo step for the whole drag
          v.begun = true;
        }
        // Snap to other vertices (not to itself) and Ortho from the neighbour
        const target = this.snapVertex(g.toPage(view), v, e);
        this.store.moveVertex(v.el, v.index, target);
        break;
      }
      case 'text':
        if (this.textSelect.startedOnWord) void this.textSelect.extend(g.toPage(view), 2 / this.zoom() + 1);
        else this.marquee.set(rectFromPoints(d.startView, view));
        break;
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
      case 'overlayScale': {
        const grab = this.overlayGrab;
        if (!grab) break;
        const distance = Math.hypot(view.x - grab.center.x, view.y - grab.center.y);
        this.store.updateOverlay({ scale: Math.min(10, Math.max(0.05, grab.scale * distance / grab.distance)) });
        break;
      }
      case 'overlayRotate': {
        const grab = this.overlayGrab;
        if (!grab) break;
        const angle = Math.atan2(view.y - grab.center.y, view.x - grab.center.x);
        let rotation = grab.rotation + (angle - grab.angle) * 180 / Math.PI;
        rotation = ((rotation + 540) % 360) - 180;
        if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;      // Shift: steps of 15°
        this.store.updateOverlay({ rotation: Math.round(rotation * 10) / 10 });
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
      case 'vertex':
        if (this.vertexDrag?.begun) s.finishVertexEdit();
        this.vertexDrag = null;
        break;
      case 'text':
        if (box && !this.textSelect.startedOnWord && box.w * this.zoom() > 3 && box.h * this.zoom() > 3) {
          void this.textSelect.selectBox(this.pageIndex(), g.rectToPage(box));
        }
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

    // Ctrl+C copies the selected measurements and markups; Ctrl+V pastes what was copied last
    // (elements at the cursor, or the Snapshot region)
    const command = e.ctrlKey || e.metaKey;
    if (command && e.key.toLowerCase() === 'c' && !this.textSelect.active() && s.tool === 'none' && s.selection.length) {
      if (s.copySelection()) e.preventDefault();
      return;
    }
    if (command && e.key.toLowerCase() === 'v' && s.canPaste && (s.clipboardKind === 'elements' || !s.snapshotClip)) {
      e.preventDefault();
      if (s.tool !== 'none') s.cancelTool();
      s.pasteElements(this.pageIndex(), this.lastMousePage);
      return;
    }
    // Snapshot: Ctrl+V / ⌘V pastes the copied region, Esc leaves the tool
    if (command && e.key.toLowerCase() === 'v' && s.snapshotClip) {
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
    // Cut Out: Enter closes the hole, Backspace removes its last corner, Esc drops it then leaves the tool
    if (this.cutout.active()) {
      if (e.key === 'Enter') { e.preventDefault(); this.cutout.finish(); return; }
      if (e.key === 'Backspace' && this.cutout.current()) { e.preventDefault(); this.cutout.undoPoint(); return; }
      if (e.key === 'Escape') { this.cutout.escape(); this.hover.set(null); return; }
    }
    // Joist Tool: Enter closes the area, Backspace removes the last point, Esc steps back then leaves
    if (this.joist.open()) {
      if (e.key === 'Enter' && this.joist.mode() === 'area') { e.preventDefault(); this.joist.finish(); return; }
      if (e.key === 'Backspace' && this.joist.current()) { e.preventDefault(); this.joist.undoPoint(); return; }
      if (e.key === 'Escape') { this.joist.escape(); this.hover.set(null); return; }
    }
    // Pitch / Triangulate: Esc drops the points in progress, then leaves the tool
    if (this.calc.mode() && e.key === 'Escape') {
      this.calc.escape();
      this.hover.set(null);
      return;
    }
    // Select Text: Ctrl+C copies, Ctrl+A selects the page, Esc clears the selection then leaves the tool
    if (this.textSelect.active()) {
      const command = e.ctrlKey || e.metaKey;
      if (command && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void this.textSelect.copy();
        return;
      }
      if (command && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        void this.textSelect.selectAll(this.pageIndex());
        return;
      }
      if (e.key === 'Escape') {
        if (this.textSelect.selection()) this.textSelect.selection.set(null); else this.textSelect.stop();
        return;
      }
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
    if (this.cutout.active()) {
      this.cutout.finish();
      return;
    }
    if (this.joist.mode()) {
      if (this.joist.mode() === 'area') this.joist.finish();
      return;
    }
    if (this.textSelect.active()) {
      const point = this.pagePoint(e);
      if (point) void this.textSelect.selectWord(this.pageIndex(), point, 2 / this.zoom() + 1);
      return;
    }
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
    const result = await renderRegion(g, { x: 0, y: 0, w: g.width, h: g.height }, scale,
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
    const result = await renderRegion(g, region, scale, t => this.renderTasks.push(t));
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
