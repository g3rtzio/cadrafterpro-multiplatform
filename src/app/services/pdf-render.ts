import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { Pt, Rect } from '../models/takeoff';

// Draws the PDF pages with pdf.js (it plays the role PDFKit's PDFView had on the Mac).
// Markups are not drawn by pdf.js: the app draws them on its own SVG layer,
// so they can be selected, moved and hidden.
pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

export async function openRenderer(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js takes ownership of the buffer, so it gets its own copy
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    wasmUrl: 'wasm/',
  }).promise;
}

// Converts between page coordinates (PDF points, y up) and "view" coordinates
// (CSS pixels of the page at 100 %, y down, with the page rotation applied)
export class PageGeometry {
  readonly width: number;                  // view size at 100 %
  readonly height: number;
  private readonly viewport: PageViewport;

  constructor(readonly page: PDFPageProxy) {
    this.viewport = page.getViewport({ scale: 1 });
    this.width = this.viewport.width;
    this.height = this.viewport.height;
  }

  toView(p: Pt): Pt {
    const [x, y] = this.viewport.convertToViewportPoint(p.x, p.y);
    return { x, y };
  }

  toPage(v: Pt): Pt {
    const [x, y] = this.viewport.convertToPdfPoint(v.x, v.y);
    return { x, y };
  }

  rectToView(r: Rect): Rect {
    const a = this.toView({ x: r.x, y: r.y });
    const b = this.toView({ x: r.x + r.w, y: r.y + r.h });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  rectToPage(r: Rect): Rect {
    const a = this.toPage({ x: r.x, y: r.y });
    const b = this.toPage({ x: r.x + r.w, y: r.y + r.h });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  // Sheet size as displayed, in inches ("48.00 x 36.00 in")
  get sizeText(): string {
    return `${(this.width / 72).toFixed(2)} x ${(this.height / 72).toFixed(2)} in`;
  }
}

// Renders part of a page (`region`, in view coordinates) at `scale` device pixels per view unit.
// Returns the canvas when it finished, or null if it was cancelled.
export async function renderRegion(page: PDFPageProxy, region: Rect, scale: number,
                                   onTask?: (task: RenderTask) => void): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(region.w * scale));
  canvas.height = Math.max(1, Math.floor(region.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],
    annotationMode: pdfjs.AnnotationMode.DISABLE,
  });
  onTask?.(task);
  try {
    await task.promise;
    return canvas;
  } catch {
    return null;                           // cancelled (the zoom or the page changed)
  }
}

// MARK: - Snap points: vertices of the vector drawing (line ends, corners)
// Read from the page's drawing commands, stored in a grid so the nearest one is found fast.
export class SnapIndex {
  private static readonly cellSize = 16;   // grid cell, in PDF points
  private readonly grid = new Map<string, Pt[]>();
  count = 0;

  constructor(points: Pt[]) {
    const seen = new Set<string>();
    for (const p of points) {
      // Same vertex drawn twice (shared corners): keep one
      const key = `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = this.cellKey(Math.floor(p.x / SnapIndex.cellSize), Math.floor(p.y / SnapIndex.cellSize));
      const list = this.grid.get(cell);
      if (list) list.push(p); else this.grid.set(cell, [p]);
      this.count += 1;
    }
  }

  // Nearest vertex within `radius` (PDF points), or null
  nearest(point: Pt, radius: number): Pt | null {
    const size = SnapIndex.cellSize;
    let best: Pt | null = null;
    let bestDistance = radius;
    for (let cx = Math.floor((point.x - radius) / size); cx <= Math.floor((point.x + radius) / size); cx++) {
      for (let cy = Math.floor((point.y - radius) / size); cy <= Math.floor((point.y + radius) / size); cy++) {
        for (const p of this.grid.get(this.cellKey(cx, cy)) ?? []) {
          const d = Math.hypot(p.x - point.x, p.y - point.y);
          if (d <= bestDistance) {
            bestDistance = d;
            best = p;
          }
        }
      }
    }
    return best;
  }

  private cellKey(x: number, y: number): string {
    return `${x},${y}`;
  }

  // Reads the page's operator list and collects the path vertices.
  // pdf.js already expands forms (blocks, details) and rectangles into paths.
  static async build(page: PDFPageProxy, limit = 400_000): Promise<SnapIndex> {
    const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
    const OPS = pdfjs.OPS;
    const points: Pt[] = [];
    type Matrix = [number, number, number, number, number, number];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const concat = (m: number[]): Matrix => [
      m[0] * ctm[0] + m[1] * ctm[2], m[0] * ctm[1] + m[1] * ctm[3],
      m[2] * ctm[0] + m[3] * ctm[2], m[2] * ctm[1] + m[3] * ctm[3],
      m[4] * ctm[0] + m[5] * ctm[2] + ctm[4], m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
    ];
    const add = (x: number, y: number) => {
      if (points.length < limit) points.push({ x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5] });
    };

    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i];
      const args = list.argsArray[i];
      switch (fn) {
        case OPS.save: stack.push(ctm); break;
        case OPS.restore: ctm = stack.pop() ?? ctm; break;
        case OPS.transform: ctm = concat(args); break;
        case OPS.paintFormXObjectBegin:
          stack.push(ctm);
          if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = concat(Array.from(args[0] as number[]));
          break;
        case OPS.paintFormXObjectEnd: ctm = stack.pop() ?? ctm; break;
        case OPS.constructPath: {
          // [paint op, [path data], min/max]; path data = op code followed by its numbers:
          // 0 moveTo (x y), 1 lineTo (x y), 2 curveTo (6), 3 quadraticCurveTo (4), 4 closePath
          const data = args?.[1]?.[0] as ArrayLike<number> | undefined;
          if (!data) break;
          let k = 0;
          while (k < data.length) {
            const op = data[k];
            if (op === 0 || op === 1) { add(data[k + 1], data[k + 2]); k += 3; }
            else if (op === 2) { add(data[k + 5], data[k + 6]); k += 7; }
            else if (op === 3) { add(data[k + 3], data[k + 4]); k += 5; }
            else k += 1;
          }
          break;
        }
      }
    }
    return new SnapIndex(points);
  }
}
