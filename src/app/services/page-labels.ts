import { Injectable, inject, signal } from '@angular/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Rect } from '../models/takeoff';
import { DrawingStore } from './drawing.store';
import { OcrService } from './ocr';
import { PageGeometry } from './pdf-render';

// Create Page Labels (like Revu's Thumbnails › Create Page Labels): names every page from
// the PDF bookmarks, or from the text inside a box (the sheet number in the title block),
// read from the PDF text and, for scanned sheets, with OCR.

export type LabelSource = 'bookmarks' | 'region';

// Box chosen on a page, as fractions of the page (so it fits pages of other sizes too)
export interface LabelRegion { x: number; y: number; w: number; h: number; }

@Injectable({ providedIn: 'root' })
export class PageLabeler {
  private readonly store = inject(DrawingStore);
  private readonly ocr = inject(OcrService);

  readonly dialogOpen = signal(false);
  readonly source = signal<LabelSource>('bookmarks');
  readonly allPages = signal(true);
  readonly range = signal('');
  readonly region = signal<LabelRegion | null>(null);
  readonly preview = signal<string | null>(null);   // text in the box on the page where it was drawn
  readonly selecting = signal(false);               // the dialog waits for a box on the plan
  readonly progress = signal<string | null>(null);  // running
  private cancelled = false;

  open(): void {
    if (!this.store.hasDocument) return;
    this.dialogOpen.set(true);
  }

  close(): void {
    this.cancelled = true;
    this.selecting.set(false);
    this.dialogOpen.set(false);
  }

  // "Select": the dialog steps aside until a box is dragged on the plan
  startSelecting(): void {
    this.store.cancelTool();
    this.source.set('region');
    this.selecting.set(true);
    this.store.showToast('Drag a box around the page name or sheet number (Esc cancels)');
  }

  cancelSelecting(): void {
    this.selecting.set(false);
  }

  // Box dragged on the plan (view coordinates of that page)
  async finishSelecting(pageIndex: number, box: Rect): Promise<void> {
    this.selecting.set(false);
    const g = this.store.pages[pageIndex];
    if (!g) return;
    this.region.set({ x: box.x / g.width, y: box.y / g.height, w: box.w / g.width, h: box.h / g.height });
    this.preview.set('Reading…');
    try {
      this.preview.set(await this.textIn(g, this.areaOn(g, this.region()!)) || '(no text found)');
    } catch {
      this.preview.set('(no text found)');
    }
  }

  // OK: reads every page of the range and renames it. Pages where nothing is found keep their name.
  async apply(pages: number[]): Promise<void> {
    const s = this.store;
    if (!s.hasDocument || pages.length === 0) return;
    this.cancelled = false;
    const names = new Map<number, string>();
    try {
      if (this.source() === 'bookmarks') {
        this.progress.set('Reading bookmarks…');
        const fromBookmarks = await this.bookmarkNames();
        for (const i of pages) {
          const name = fromBookmarks.get(i);
          if (name) names.set(i, name);
        }
        if (fromBookmarks.size === 0) {
          s.showToast('This PDF has no bookmarks. Use Page Region instead.', true);
          return;
        }
      } else {
        const region = this.region();
        if (!region) return;
        for (let k = 0; k < pages.length && !this.cancelled; k++) {
          const i = pages[k];
          this.progress.set(`Reading ${s.pageName(i)} (${k + 1} of ${pages.length})…`);
          const g = s.pages[i];
          if (!g) continue;
          const text = await this.textIn(g, this.areaOn(g, region)).catch(() => '');
          if (text) names.set(i, text);
        }
        if (this.cancelled) return;
      }
      s.renamePages(names);
      const missed = pages.length - names.size;
      s.showToast(`Renamed ${names.size} page${names.size === 1 ? '' : 's'}`
        + (missed ? ` (${missed} without text kept their name)` : ''), names.size === 0);
      this.dialogOpen.set(false);
    } finally {
      this.progress.set(null);
    }
  }

  // MARK: - Bookmarks
  // Page index → title. The deepest bookmark of a page wins (a sheet's own bookmark rather than
  // the folder that points to the first sheet of its discipline).
  private async bookmarkNames(): Promise<Map<number, string>> {
    const s = this.store;
    const renderer = s.renderer;
    const result = new Map<number, { title: string; depth: number }>();
    if (!renderer) return new Map();
    const outline = await renderer.getOutline().catch(() => null);
    type Item = { title: string; dest: string | unknown[] | null; items: Item[] };
    const walk = async (items: Item[], depth: number) => {
      for (const item of items) {
        const index = await this.destPage(renderer, item.dest);
        const title = cleanName(item.title);
        if (index !== null && title) {
          const known = result.get(index);
          if (!known || depth > known.depth) result.set(index, { title, depth });
        }
        if (item.items?.length) await walk(item.items, depth + 1);
      }
    };
    await walk((outline ?? []) as Item[], 0);
    return new Map([...result].map(([i, v]) => [i, v.title]));
  }

  // Where a bookmark points, as the page's position in the app (pages may have been moved)
  private async destPage(renderer: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
    try {
      const explicit = typeof dest === 'string' ? await renderer.getDestination(dest) : dest;
      const target = explicit?.[0];
      if (target === undefined || target === null) return null;
      const original = typeof target === 'number' ? target
        : await renderer.getPageIndex(target as { num: number; gen: number });
      const proxy = await renderer.getPage(original + 1);
      const index = this.store.pages.findIndex(g => g.page === proxy);
      return index >= 0 ? index : null;
    } catch {
      return null;
    }
  }

  // MARK: - Text in a box
  private areaOn(g: PageGeometry, r: LabelRegion): Rect {
    return { x: r.x * g.width, y: r.y * g.height, w: r.w * g.width, h: r.h * g.height };
  }

  // The PDF's own text first; a scanned sheet (no text there) is read with OCR
  private async textIn(g: PageGeometry, area: Rect): Promise<string> {
    const text = await pdfTextIn(g, area);
    if (text) return text;
    return cleanName(await this.ocr.readText(g, area));
  }
}

// Text pieces of the page whose middle falls inside `area` (view coordinates), in reading order.
// Works for rotated text too (title blocks often run bottom to top along the sheet edge).
export async function pdfTextIn(g: PageGeometry, area: Rect): Promise<string> {
  const content = await g.page.getTextContent();
  const pieces: { str: string; along: number; across: number; size: number }[] = [];
  let ux = 1, uy = 0;                                    // reading direction on screen
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
    if (!item.str || !item.str.trim() || !item.transform) continue;
    const [a, b, c, d, e, f] = item.transform;
    const scaleX = Math.hypot(a, b) || 1, scaleY = Math.hypot(c, d) || 1;
    const width = item.width ?? 0, height = item.height || scaleY;
    // Middle of the piece: half its width along the baseline, a third of its height up
    const mid = g.toView({ x: e + (a / scaleX) * width / 2 + (c / scaleY) * height / 3,
                           y: f + (b / scaleX) * width / 2 + (d / scaleY) * height / 3 });
    if (mid.x < area.x || mid.y < area.y || mid.x > area.x + area.w || mid.y > area.y + area.h) continue;
    const start = g.toView({ x: e, y: f });
    if (pieces.length === 0) {
      // The first piece sets the reading direction (its baseline as seen on screen)
      const end = g.toView({ x: e + a / scaleX, y: f + b / scaleX });
      const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      ux = (end.x - start.x) / length;
      uy = (end.y - start.y) / length;
    }
    pieces.push({
      str: item.str,
      along: start.x * ux + start.y * uy,                // position along the line
      across: -start.x * uy + start.y * ux,              // which line
      size: height,
    });
  }
  if (pieces.length === 0) return '';
  // Lines: pieces whose baselines are closer than half a letter; then left to right along each line
  pieces.sort((p, q) => p.across - q.across);
  const lines: (typeof pieces)[] = [];
  for (const p of pieces) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(p.across - line[0].across) < Math.max(p.size, line[0].size) * 0.5) line.push(p);
    else lines.push([p]);
  }
  return cleanName(lines.map(line => line.sort((p, q) => p.along - q.along).map(p => p.str).join(' ')).join(' '));
}

// One line, single spaces, no line breaks, not too long for a page name
function cleanName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}
