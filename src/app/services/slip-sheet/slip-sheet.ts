import { Injectable, computed, inject, signal } from '@angular/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { DrawingStore } from '../drawing.store/drawing.store';
import { openRenderer } from '../pdf-render/pdf-render';

// Slip Sheet (like Bluebeam Revu): pick another PDF (an addendum, a new revision) and replace, in one
// go, the pages of this document that have the same name. Markups, measurements, highlights, scales
// and page names stay on the replaced pages. Names come from the other file's bookmarks and page
// labels; a page is matched by its full name, or else by its sheet number ("A-101").

export interface SlipRow {
  source: number;           // page of the other file (0-based)
  name: string;             // its name (shown)
  candidates: string[];     // names to match with (bookmark, page label)
  target: number | null;    // page of this document it replaces, null = none
}

export interface SlipRequest {
  fileName: string;
  bytes: Uint8Array;
  renderer: PDFDocumentProxy;
  rows: SlipRow[];
}

@Injectable({ providedIn: 'root' })
export class SlipSheet {
  private readonly store = inject(DrawingStore);

  readonly request = signal<SlipRequest | null>(null);
  readonly appendUnmatched = signal(false);
  readonly busy = signal(false);

  readonly replaceCount = computed(() => this.request()?.rows.filter(r => r.target !== null).length ?? 0);
  readonly unmatchedCount = computed(() => this.request()?.rows.filter(r => r.target === null).length ?? 0);

  // Ribbon button: choose the PDF with the new pages
  pick(): void {
    if (!this.store.hasDocument || this.busy()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void file.arrayBuffer().then(buffer => this.open(new Uint8Array(buffer), file.name));
    };
    input.click();
  }

  async open(bytes: Uint8Array, fileName: string): Promise<void> {
    this.busy.set(true);
    try {
      const renderer = await openRenderer(bytes);
      const names = await sourceNames(renderer);
      const rows: SlipRow[] = names.map((candidates, source) => ({
        source, candidates, name: candidates[0] || `Page ${source + 1}`, target: null,
      }));
      this.matchByName(rows);
      this.cancel();
      this.request.set({ fileName, bytes, renderer, rows });
      if (!rows.some(r => r.target !== null)) {
        this.store.showToast(`No page names of ${fileName} match this document. Pick the pages by hand.`, true);
      }
    } catch (error) {
      console.error(error);
      this.store.showToast(`Couldn't read ${fileName}`, true);
    } finally {
      this.busy.set(false);
    }
  }

  // Same name first, then same sheet number; each page of this document is replaced once
  private matchByName(rows: SlipRow[]): void {
    const s = this.store;
    const used = new Set<number>();
    const targets = Array.from({ length: s.pageCount }, (_, i) => ({ index: i, name: normalize(s.pageName(i)) }));
    const pass = (key: (name: string) => string) => {
      for (const row of rows) {
        if (row.target !== null) continue;
        const keys = row.candidates.map(c => key(normalize(c))).filter(Boolean);
        const hit = targets.find(t => !used.has(t.index) && keys.includes(key(t.name)));
        if (hit) { row.target = hit.index; used.add(hit.index); }
      }
    };
    pass(name => name);
    pass(sheetNumber);
  }

  setTarget(source: number, target: number | null): void {
    this.request.update(r => r && {
      ...r,
      rows: r.rows.map(row => row.source === source ? { ...row, target }
        // A page of this document is replaced by one page only
        : target !== null && row.target === target ? { ...row, target: null } : row),
    });
  }

  rematch(): void {
    const r = this.request();
    if (!r) return;
    const rows = r.rows.map(row => ({ ...row, target: null }));
    this.matchByName(rows);
    this.request.set({ ...r, rows });
  }

  clearAll(): void {
    this.request.update(r => r && { ...r, rows: r.rows.map(row => ({ ...row, target: null })) });
  }

  cancel(): void {
    const r = this.request();
    if (r) void r.renderer.destroy();
    this.request.set(null);
  }

  async apply(): Promise<void> {
    const r = this.request();
    if (!r || this.busy()) return;
    const pairs = r.rows.filter(row => row.target !== null).map(row => ({ target: row.target!, source: row.source }));
    const append = this.appendUnmatched()
      ? r.rows.filter(row => row.target === null).map(row => ({ source: row.source, label: row.candidates[0] ?? '' }))
      : [];
    if (pairs.length === 0 && append.length === 0) return;
    this.busy.set(true);
    try {
      // The store keeps the other file's pages (it now owns the renderer)
      await this.store.slipSheet(r.bytes, r.renderer, r.fileName, pairs, append);
      this.request.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}

// "  a-101   Floor Plan " → "A-101 FLOOR PLAN"
function normalize(name: string): string {
  return name.toUpperCase().replace(/\s+/g, ' ').replace(/[\s.:;,-]+$/, '').trim();
}

// First token that looks like a sheet number: "A-101", "E2.1", "M101" ('' when there is none)
function sheetNumber(name: string): string {
  const token = name.split(/[\s_]+/).find(t => /^[A-Z]{0,3}[-.]?\d+([.-]\d+)*[A-Z]?$/.test(t) && /\d/.test(t));
  return token ? token.replace(/[-.]/g, '') : '';
}

// Names of every page of the other file: its deepest bookmark, then its page label (not plain numbers)
async function sourceNames(renderer: PDFDocumentProxy): Promise<string[][]> {
  const count = renderer.numPages;
  const names: string[][] = Array.from({ length: count }, () => []);
  const bookmarks = new Map<number, { title: string; depth: number }>();
  type Item = { title: string; dest: string | unknown[] | null; items: Item[] };
  const walk = async (items: Item[], depth: number) => {
    for (const item of items) {
      const index = await destIndex(renderer, item.dest);
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (index !== null && title) {
        const known = bookmarks.get(index);
        if (!known || depth > known.depth) bookmarks.set(index, { title, depth });
      }
      if (item.items?.length) await walk(item.items, depth + 1);
    }
  };
  await walk(((await renderer.getOutline().catch(() => null)) ?? []) as Item[], 0);
  const labels = await renderer.getPageLabels().catch(() => null);
  for (let i = 0; i < count; i++) {
    const bookmark = bookmarks.get(i)?.title;
    if (bookmark) names[i].push(bookmark);
    const label = labels?.[i]?.trim();
    if (label && label !== String(i + 1) && label !== bookmark) names[i].push(label);
  }
  return names;
}

async function destIndex(renderer: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await renderer.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (target === undefined || target === null) return null;
    return typeof target === 'number' ? target : await renderer.getPageIndex(target as { num: number; gen: number });
  } catch {
    return null;
  }
}
