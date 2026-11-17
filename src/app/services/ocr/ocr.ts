import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  PDFArray, PDFDocument, PDFFont, PDFOperator, PDFRef, StandardFonts, TextRenderingMode,
  beginText, endText, popGraphicsState, pushGraphicsState, setCharacterSqueeze, setFontAndSize,
  setTextMatrix, setTextRenderingMode, showText,
} from 'pdf-lib';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { Pt, Rect } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { PageGeometry, renderRegion } from '../pdf-render/pdf-render';

// OCR (text recognition) of plan pages, done in the browser with Tesseract.js.
// Construction drawings often have their text as vector lines (AutoCAD SHX fonts) or as a scan,
// so the PDF has no real text to search or copy. OCR reads it from the rendered image:
//  - Region: drag a box on the plan, the text inside is shown in the OCR panel (and can be copied)
//  - Page / All Pages: every word of the page is found, highlighted and listed in the panel
// Optionally the recognized words are written into the PDF as invisible text (like Bluebeam's OCR),
// so after Save the file is searchable and selectable in any PDF reader.
// Tesseract's worker, engine (wasm) and English data are copied into the build (see angular.json),
// so nothing is downloaded from the internet; the data is cached by the browser after first use.

const DPI = 300;                            // render resolution for recognition
const SCALE = DPI / 72;                     // device pixels per PDF point
const TILE = 2400 / SCALE;                  // tile core size, in view units (PDF points)
const MARGIN = 48;                          // overlap around each tile, in view units
const MIN_CONFIDENCE = 45;                  // words below this confidence are dropped

// Reading direction of a word on the page: 0 = left to right, 90 = bottom to top (vertical text)
export type OcrDirection = 0 | 90;

export interface OcrWord {
  text: string;
  confidence: number;
  view: Rect;                               // view coordinates (page at 100 %, y down)
  rect: Rect;                               // page coordinates (PDF points, y up)
  direction: OcrDirection;
  line: number;                             // index of its line in OcrResult.lines
}

export interface OcrLine {
  text: string;
  view: Rect;
  direction: OcrDirection;
}

export interface OcrResult {
  page: PageGeometry;                       // keyed by the page object, so it survives page reordering
  area: Rect;                               // the recognized area (view coordinates)
  words: OcrWord[];
  lines: OcrLine[];
  text: string;                             // lines in reading order, one per row
  isRegion: boolean;
  embedded: boolean;                        // written into the PDF as invisible text
}

export interface OcrMatch {
  pageIndex: number;
  word: OcrWord;
  lineText: string;
}

export interface OcrProgress {
  status: string;
  value: number;                            // 0…1
}

@Injectable({ providedIn: 'root' })
export class OcrService {
  private readonly store = inject(DrawingStore);

  // UI state
  readonly panelOpen = signal(false);
  readonly drawingRegion = signal(false);   // the plan waits for a box to be dragged
  readonly progress = signal<OcrProgress | null>(null);
  readonly busy = computed(() => this.progress() !== null);
  readonly results = signal<OcrResult[]>([]);     // page results, then region results (last one at the end)
  readonly lastRegion = signal<OcrResult | null>(null);
  readonly focus = signal<{ page: PageGeometry; view: Rect } | null>(null);   // word to show on the plan

  // Options (panel checkboxes)
  readonly showHighlights = signal(true);
  readonly includeVertical = signal(false);
  readonly makeSearchable = signal(true);

  private worker: Promise<TesseractWorker> | null = null;
  private jobProgress = 0;                  // progress of the tile Tesseract is reading now (0…1)
  private cancelled = false;
  private lib: PDFDocument | null = null;
  private fonts = new WeakMap<PDFDocument, Promise<PDFFont>>();
  private embeddedStreams = new WeakMap<PageGeometry, PDFRef>();

  constructor() {
    // A rotated page gets a new geometry: its results follow it, in the new view coordinates
    this.store.onPageSwap((old, next) => {
      const move = (r: Rect) => next.rectToView(old.rectToPage(r));
      if (!this.results().some(r => r.page === old)) return;
      this.results.update(list => list.map(r => r.page !== old ? r : {
        ...r, page: next, area: move(r.area),
        words: r.words.map(w => ({ ...w, view: move(w.view) })),
        lines: r.lines.map(l => ({ ...l, view: move(l.view) })),
      }));
      const stream = this.embeddedStreams.get(old);
      if (stream) this.embeddedStreams.set(next, stream);
    });
    // Another document was opened (or it was closed): the old results don't belong to it
    effect(() => {
      const s = this.store.watch();
      if (s.lib !== this.lib) {
        this.lib = s.lib;
        this.cancelled = true;
        this.results.set([]);
        this.lastRegion.set(null);
        this.focus.set(null);
        this.drawingRegion.set(false);
        this.embeddedStreams = new WeakMap();
      }
    });
  }

  // MARK: - Queries (also for the plan highlights and the text search)
  pageIndexOf(page: PageGeometry): number {
    return this.store.pages.indexOf(page);
  }

  // Page result (not regions) of a page, if it was recognized
  pageResult(pageIndex: number): OcrResult | null {
    const page = this.store.pages[pageIndex];
    return this.results().find(r => r.page === page && !r.isRegion) ?? null;
  }

  // All the recognized words on a page (page results and regions), for highlighting
  wordsOn(pageIndex: number): OcrWord[] {
    const page = this.store.pages[pageIndex];
    if (!page) return [];
    return this.results().filter(r => r.page === page).flatMap(r => r.words);
  }

  // Finds text in the OCR results (case insensitive): one match per line that contains it
  search(query: string): OcrMatch[] {
    const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return [];
    const first = q.split(' ')[0];
    const matches: OcrMatch[] = [];
    for (const r of this.results()) {
      const pageIndex = this.pageIndexOf(r.page);
      if (pageIndex < 0) continue;
      r.lines.forEach((line, i) => {
        if (!line.text.toLowerCase().includes(q)) return;
        const lineWords = r.words.filter(w => w.line === i);
        const word = lineWords.find(w => w.text.toLowerCase().includes(first)) ?? lineWords[0];
        if (word) matches.push({ pageIndex, word, lineText: line.text });
      });
    }
    return matches.sort((a, b) => a.pageIndex - b.pageIndex || a.word.view.y - b.word.view.y || a.word.view.x - b.word.view.x);
  }

  // MARK: - Commands (ribbon)
  startRegion(): void {
    if (!this.store.hasDocument) return;
    if (this.busy()) return this.store.showToast('OCR is already running', true);
    this.store.cancelTool();
    if (this.store.drawingViewport) this.store.cancelViewport();
    this.drawingRegion.set(true);
    this.store.showToast('Drag a box around the text to recognize (Esc cancels)');
  }

  cancelRegion(): void {
    this.drawingRegion.set(false);
  }

  // Box dragged on the plan (view coordinates of that page)
  async finishRegion(pageIndex: number, area: Rect): Promise<void> {
    this.drawingRegion.set(false);
    const page = this.store.pages[pageIndex];
    if (!page) return;
    this.panelOpen.set(true);
    await this.run([{ page, area, isRegion: true }]);
  }

  // Text of a region, read without the OCR panel and without keeping a result
  // (Create Page Labels uses it for scanned sheets). Empty when nothing was read.
  async readText(page: PageGeometry, area: Rect): Promise<string> {
    if (this.busy()) throw new Error('OCR is already running');
    this.cancelled = false;
    const worker = await this.getWorker();
    const result = await this.recognize(worker, page, area, true, () => undefined);
    return result?.text.trim() ?? '';
  }

  async recognizeCurrentPage(): Promise<void> {
    const page = this.store.pages[this.store.currentPageIndex];
    if (!page) return;
    await this.run([{ page, area: { x: 0, y: 0, w: page.width, h: page.height }, isRegion: false }]);
  }

  async recognizeAllPages(): Promise<void> {
    await this.run(this.store.pages.map(page => ({ page, area: { x: 0, y: 0, w: page.width, h: page.height }, isRegion: false })));
  }

  cancel(): void {
    this.cancelled = true;
  }

  // Forgets the results (the text already written into the PDF stays until it is closed without saving)
  clear(): void {
    this.results.set([]);
    this.lastRegion.set(null);
    this.focus.set(null);
  }

  // Shows a word on the plan: goes to its page and centers it
  show(match: OcrMatch): void {
    this.store.goTo(match.pageIndex);
    this.focus.set({ page: this.store.pages[match.pageIndex], view: match.word.view });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.store.showToast('Text copied');
    } catch {
      this.store.showToast("Couldn't copy the text", true);
    }
  }

  // MARK: - Recognition
  private async run(jobs: { page: PageGeometry; area: Rect; isRegion: boolean }[]): Promise<void> {
    if (!jobs.length) return;
    if (this.busy()) return this.store.showToast('OCR is already running', true);
    this.cancelled = false;
    this.panelOpen.set(true);
    const lib = this.store.lib;
    let wordCount = 0;
    try {
      this.progress.set({ status: 'Loading the OCR engine…', value: 0 });
      const worker = await this.getWorker();
      for (let j = 0; j < jobs.length && !this.cancelled; j++) {
        const job = jobs[j];
        const pageIndex = this.pageIndexOf(job.page);
        const label = job.isRegion ? 'region' : jobs.length > 1 ? `page ${pageIndex + 1} (${j + 1} of ${jobs.length})` : `page ${pageIndex + 1}`;
        const result = await this.recognize(worker, job.page, job.area, job.isRegion, (done, total) => {
          const within = (done + this.jobProgress) / total;
          this.progress.set({ status: `Reading ${label}…`, value: (j + within) / jobs.length });
        });
        if (!result || this.cancelled) break;
        wordCount += result.words.length;
        // A new page result replaces the old one of that page; regions pile up
        this.results.update(list => [
          ...list.filter(r => job.isRegion || r.isRegion || r.page !== job.page),
          result,
        ]);
        if (job.isRegion) this.lastRegion.set(result);
        if (!job.isRegion && this.makeSearchable() && lib && lib === this.store.lib && result.words.length) {
          await this.embed(lib, pageIndex, result);
        }
      }
      if (this.cancelled) this.store.showToast('OCR cancelled');
      else if (jobs.length === 1 && jobs[0].isRegion) {
        this.store.showToast(wordCount ? `Recognized ${wordCount} words` : 'No text found in the region', !wordCount);
      } else {
        const extra = this.makeSearchable() && wordCount ? ' — Save to keep the text in the PDF' : '';
        this.store.showToast(`OCR found ${wordCount} words${extra}`, !wordCount);
      }
    } catch (error) {
      console.error(error);
      this.worker = null;
      this.store.showToast("OCR failed. See the browser console for details.", true);
    } finally {
      this.progress.set(null);
      this.store.touch();
    }
  }

  // One Tesseract worker, created on first use and kept for the next runs
  private getWorker(): Promise<TesseractWorker> {
    if (!this.worker) {
      this.worker = (async () => {
        // Loaded only when OCR is used, so it doesn't weigh on the app start
        const tesseract = await import('tesseract.js');
        const createWorker = tesseract.createWorker ?? (tesseract as unknown as { default: typeof tesseract }).default.createWorker;
        // Engine, worker and English data are served by the app itself (copied by angular.json),
        // so OCR works offline and doesn't depend on a CDN. The worker needs absolute URLs.
        const base = (path: string) => new URL(path, document.baseURI).href;
        return createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
          workerPath: base('ocr/worker.min.js'),
          corePath: base('ocr/core/'),
          langPath: base('ocr/lang'),
          logger: m => {
            if (m.status === 'recognizing text') this.jobProgress = m.progress;
          },
        });
      })();
      this.worker.catch(() => (this.worker = null));
    }
    return this.worker;
  }

  // Reads an area of a page tile by tile (big sheets don't fit in one image at 300 dpi).
  // Each tile is rendered with a margin, and only the words whose center falls inside the tile's
  // own part are kept, so words cut by a tile edge are read whole by the neighbor tile.
  private async recognize(worker: TesseractWorker, page: PageGeometry, area: Rect, isRegion: boolean,
                          onProgress: (done: number, total: number) => void): Promise<OcrResult | null> {
    const clipped = clipRect(area, page.width, page.height);
    if (clipped.w <= 1 || clipped.h <= 1) return null;
    const columns = Math.max(1, Math.ceil(clipped.w / TILE));
    const rows = Math.max(1, Math.ceil(clipped.h / TILE));
    const passes = this.includeVertical() ? 2 : 1;
    const total = columns * rows * passes;
    const words: OcrWord[] = [];
    const lines: OcrLine[] = [];

    // Sparse text (scattered labels) for whole drawings; automatic layout for a region (notes, tables)
    await worker.setParameters({
      tessedit_pageseg_mode: (isRegion ? '3' : '11') as never,
      user_defined_dpi: String(DPI),
      preserve_interword_spaces: '1',
    });

    let done = 0;
    for (let pass = 0; pass < passes; pass++) {
      const direction: OcrDirection = pass === 0 ? 0 : 90;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          if (this.cancelled) return null;
          this.jobProgress = 0;
          onProgress(done, total);
          const core: Rect = {
            x: clipped.x + col * clipped.w / columns,
            y: clipped.y + row * clipped.h / rows,
            w: clipped.w / columns,
            h: clipped.h / rows,
          };
          // Regions are read exactly as boxed; page tiles get a margin
          const tile = isRegion && columns * rows === 1 ? core : clipRect(
            { x: core.x - MARGIN, y: core.y - MARGIN, w: core.w + 2 * MARGIN, h: core.h + 2 * MARGIN },
            page.width, page.height);
          const inside = isRegion ? clipped : clipRect(core, page.width, page.height);
          await this.readTile(worker, page, tile, inside, direction, words, lines);
          done += 1;
          onProgress(done, total);
        }
      }
    }

    // Vertical pass: horizontal text read sideways comes out as junk on top of real words, drop it
    const kept = words.filter(w => w.direction === 0
      || !words.some(h => h.direction === 0 && overlap(h.view, w.view) > 0.3 * Math.min(area2(h.view), area2(w.view))));
    // Reindex lines to the kept words only
    const used = [...new Set(kept.map(w => w.line))];
    const lineMap = new Map(used.map((old, i) => [old, i]));
    const finalLines = used.map(i => lines[i]);
    const finalWords = kept.map(w => ({ ...w, line: lineMap.get(w.line)! }));
    finalLines.forEach((line, i) => {
      line.text = finalWords.filter(w => w.line === i)
        .sort((a, b) => line.direction === 0 ? a.view.x - b.view.x : b.view.y - a.view.y)
        .map(w => w.text).join(' ');
    });
    const ordered = [...finalLines].filter(l => l.text).sort((a, b) =>
      a.direction - b.direction || rowOrder(a.view, b.view));

    return {
      page, area: clipped, words: finalWords, lines: finalLines, isRegion, embedded: false,
      text: ordered.map(l => l.text).join('\n'),
    };
  }

  private async readTile(worker: TesseractWorker, page: PageGeometry, tile: Rect, inside: Rect, direction: OcrDirection,
                         words: OcrWord[], lines: OcrLine[]): Promise<void> {
    if (tile.w <= 1 || tile.h <= 1) return;
    const canvas = await renderRegion(page, tile, SCALE);
    if (!canvas) return;
    const image = direction === 0 ? canvas : rotateClockwise(canvas);
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });

    // Image pixels → view coordinates
    const toView = (b: { x0: number; y0: number; x1: number; y1: number }): Rect => {
      if (direction === 0) {
        return { x: tile.x + b.x0 / SCALE, y: tile.y + b.y0 / SCALE, w: (b.x1 - b.x0) / SCALE, h: (b.y1 - b.y0) / SCALE };
      }
      // Rotated 90° clockwise: rotated (X, Y) is original (Y, H − X)
      const H = canvas.height;
      return { x: tile.x + b.y0 / SCALE, y: tile.y + (H - b.x1) / SCALE, w: (b.y1 - b.y0) / SCALE, h: (b.x1 - b.x0) / SCALE };
    };

    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          const lineIndex = lines.length;
          let added = 0;
          for (const word of line.words) {
            const text = word.text.trim();
            if (!text || word.confidence < MIN_CONFIDENCE || !/[A-Za-z0-9]/.test(text)) continue;
            const view = toView(word.bbox);
            const center = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
            if (!pointIn(center, inside)) continue;
            // Lone symbols read from hatches and lines: need a decent confidence
            if (text.length === 1 && word.confidence < 75) continue;
            words.push({ text, confidence: word.confidence, view, rect: page.rectToPage(view), direction, line: lineIndex });
            added += 1;
          }
          if (added) lines.push({ text: '', view: toView(line.bbox), direction });
        }
      }
    }
  }

  // MARK: - Searchable PDF: invisible text under the drawing
  // The words go in their own content stream, wrapped in q/Q, with text render mode 3 (invisible).
  // Running OCR again on the page replaces that stream instead of adding a second copy.
  private async embed(lib: PDFDocument, pageIndex: number, result: OcrResult): Promise<void> {
    try {
      const font = await this.font(lib);
      const pdfPage = lib.getPage(pageIndex);
      const node = pdfPage.node;
      const geometry = result.page;

      // Remove the text written by an earlier OCR of this page (in this session)
      const old = this.embeddedStreams.get(geometry);
      if (old) {
        const contents = node.Contents();
        if (contents instanceof PDFArray) {
          const at = contents.asArray().findIndex(item => item === old);
          if (at >= 0) contents.remove(at);
        }
      }

      // normalize() wraps the page's own content in q/Q once, so its drawing state can't move our text
      node.normalize();
      const fontKey = node.newFontDictionary('OCR', font.ref);
      const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
      for (const word of result.words) {
        const text = winAnsi(word.text);
        if (!text) continue;
        // Origin at the start of the baseline; x axis along the reading direction, y axis up the letters
        const v = word.view;
        const horizontal = word.direction === 0;
        const origin: Pt = horizontal ? { x: v.x, y: v.y + v.h } : { x: v.x + v.w, y: v.y + v.h };
        const along: Pt = horizontal ? { x: 1, y: 0 } : { x: 0, y: -1 };
        const up: Pt = horizontal ? { x: 0, y: -1 } : { x: -1, y: 0 };
        const size = Math.max(horizontal ? v.h : v.w, 1);
        const length = horizontal ? v.w : v.h;
        const a = geometry.toPage(origin);
        const r = geometry.toPage({ x: origin.x + along.x, y: origin.y + along.y });
        const u = geometry.toPage({ x: origin.x + up.x, y: origin.y + up.y });
        let encoded;
        let width;
        try {
          encoded = font.encodeText(text);
          width = font.widthOfTextAtSize(text, size);
        } catch {
          continue;
        }
        ops.push(
          setFontAndSize(fontKey, size),
          setCharacterSqueeze(width > 0 ? Math.min(Math.max((100 * length) / width, 1), 1000) : 100),
          setTextMatrix(r.x - a.x, r.y - a.y, u.x - a.x, u.y - a.y, a.x, a.y),
          showText(encoded),
        );
      }
      ops.push(endText(), popGraphicsState());

      const ref = lib.context.register(lib.context.contentStream(ops));
      node.addContentStream(ref);
      this.embeddedStreams.set(geometry, ref);
      result.embedded = true;
    } catch (error) {
      console.error('OCR text layer', error);
    }
  }

  private font(lib: PDFDocument): Promise<PDFFont> {
    let font = this.fonts.get(lib);
    if (!font) {
      font = lib.embedFont(StandardFonts.Helvetica);
      this.fonts.set(lib, font);
    }
    return font;
  }
}

// MARK: - Helpers
function rotateClockwise(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function clipRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(r.x, 0), y = Math.max(r.y, 0);
  return { x, y, w: Math.max(Math.min(r.x + r.w, width) - x, 0), h: Math.max(Math.min(r.y + r.h, height) - y, 0) };
}

function pointIn(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function area2(r: Rect): number {
  return r.w * r.h;
}

// Reading order: top to bottom; lines whose middles are on the same row go left to right
function rowOrder(a: Rect, b: Rect): number {
  const sameRow = Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) < Math.min(a.h, b.h) / 2;
  return sameRow ? a.x - b.x : a.y - b.y;
}

// Helvetica (a standard PDF font) only has the WinAnsi characters
function winAnsi(text: string): string {
  return text.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}
