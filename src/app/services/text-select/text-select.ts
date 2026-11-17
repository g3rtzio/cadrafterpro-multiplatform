import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Pt, Rect, rectsIntersect } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { MarkupTools } from '../markup-tools/markup-tools';
import { OcrService } from '../ocr/ocr';
import { TextSearch, TextWord } from '../text-search/text-search';

// Select Text tool (Home > Markup): select the text of the plan and copy it.
// Press on a word and drag to another one to select the words between them (reading order),
// or drag a box from an empty spot to select every word it touches. Double click = one word,
// Ctrl+A = the whole page, Ctrl+C or the Copy button = copy, Esc = clear / leave the tool.
// Scanned pages use the words recognized with OCR.
@Injectable({ providedIn: 'root' })
export class TextSelect {
  private readonly store = inject(DrawingStore);
  private readonly search = inject(TextSearch);
  private readonly ocr = inject(OcrService);
  private readonly markups = inject(MarkupTools);

  readonly active = signal(false);
  readonly selection = signal<{ pageIndex: number; words: TextWord[] } | null>(null);
  private readonly words = new WeakMap<object, Promise<TextWord[]>>();
  private anchor: { pageIndex: number; word: TextWord | null; point: Pt } | null = null;

  // Selected text: words of a line joined by spaces, lines by line breaks
  readonly text = computed(() => {
    const sel = this.selection();
    if (!sel) return '';
    let out = '';
    let line = -1;
    for (const w of sel.words) {
      if (out) out += w.line === line ? ' ' : '\n';
      out += w.str;
      line = w.line;
    }
    return out;
  });

  constructor() {
    // A takeoff or markup tool, another tab or closing the drawing ends the tool
    effect(() => {
      const s = this.store.watch();
      const stop = s.tool !== 'none' || s.ribbonTab !== 'Home' || !s.hasDocument || s.drawingViewport
        || !!this.markups.tool() || s.snapshotMode !== 'none';
      untracked(() => { if (stop && this.active()) this.stop(); });
    });
  }

  toggle(): void {
    if (this.active()) return this.stop();
    if (!this.store.hasDocument) return;
    this.markups.cancel();
    this.store.cancelTool();
    this.store.selectElements([]);
    this.active.set(true);
  }

  stop(): void {
    this.active.set(false);
    this.selection.set(null);
    this.anchor = null;
  }

  // Words of a page: the PDF's own text, or the OCR words of a scanned page
  pageWords(pageIndex: number): Promise<TextWord[]> {
    const key = this.store.pages[pageIndex];
    if (!key) return Promise.resolve([]);
    let pending = this.words.get(key);
    if (!pending) {
      pending = this.search.pageTextWords(pageIndex).then(list => list.length ? list : this.ocrWords(pageIndex));
      this.words.set(key, pending);
      // OCR may run later: don't keep an empty answer
      pending.then(list => { if (!list.length) this.words.delete(key); });
    }
    return pending;
  }

  private ocrWords(pageIndex: number): TextWord[] {
    const list = this.ocr.wordsOn(pageIndex);
    return list.map((w, order) => ({ str: w.text, rect: w.rect, line: w.line, order }));
  }

  // MARK: - Selecting (page coordinates)
  async begin(pageIndex: number, point: Pt, tolerance: number): Promise<void> {
    const words = await this.pageWords(pageIndex);
    const word = wordAt(words, point, tolerance);
    this.anchor = { pageIndex, word, point };
    this.selection.set(word ? { pageIndex, words: [word] } : null);
  }

  // Drag from a word: the words between it and the one under the cursor.
  // Returns false when the drag started on an empty spot (the plan draws a box instead).
  async extend(point: Pt, tolerance: number): Promise<boolean> {
    const a = this.anchor;
    if (!a?.word) return false;
    const words = await this.pageWords(a.pageIndex);
    const end = wordAt(words, point, tolerance) ?? nearest(words, point);
    if (!end) return true;
    const [from, to] = a.word.order <= end.order ? [a.word.order, end.order] : [end.order, a.word.order];
    this.selection.set({ pageIndex: a.pageIndex, words: words.filter(w => w.order >= from && w.order <= to) });
    return true;
  }

  get startedOnWord(): boolean {
    return !!this.anchor?.word;
  }

  // Box from an empty spot: every word it touches
  async selectBox(pageIndex: number, box: Rect): Promise<void> {
    const words = await this.pageWords(pageIndex);
    const found = words.filter(w => rectsIntersect(w.rect, box));
    this.selection.set(found.length ? { pageIndex, words: found } : null);
  }

  async selectWord(pageIndex: number, point: Pt, tolerance: number): Promise<void> {
    const word = wordAt(await this.pageWords(pageIndex), point, tolerance);
    this.selection.set(word ? { pageIndex, words: [word] } : null);
  }

  async selectAll(pageIndex: number): Promise<void> {
    const words = await this.pageWords(pageIndex);
    this.selection.set(words.length ? { pageIndex, words } : null);
    if (!words.length) this.store.showToast('This page has no text. Run OCR on it first.', true);
  }

  async copy(): Promise<void> {
    const text = this.text();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.store.showToast(`Copied: ${text.length > 40 ? text.slice(0, 40).replace(/\n/g, ' ') + '…' : text.replace(/\n/g, ' ')}`);
    } catch {
      this.store.showToast("Couldn't copy. Allow the clipboard for this site.", true);
    }
  }
}

function contains(r: Rect, p: Pt, m: number): boolean {
  return p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;
}

function wordAt(words: TextWord[], p: Pt, tolerance: number): TextWord | null {
  return words.find(w => contains(w.rect, p, tolerance)) ?? null;
}

function nearest(words: TextWord[], p: Pt): TextWord | null {
  let best: TextWord | null = null;
  let distance = Infinity;
  for (const w of words) {
    const dx = Math.max(w.rect.x - p.x, 0, p.x - (w.rect.x + w.rect.w));
    const dy = Math.max(w.rect.y - p.y, 0, p.y - (w.rect.y + w.rect.h));
    const d = Math.hypot(dx, dy);
    if (d < distance) { distance = d; best = w; }
  }
  return best;
}
