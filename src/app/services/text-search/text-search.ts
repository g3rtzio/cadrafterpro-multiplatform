import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Markup, Measurement } from '../../models/elements';
import { COLORS, Pt, Rect, boundsOf } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { textWidth } from '../shapes/shapes';

// Text search of the right side bar (like Revu's Search panel): finds words in the text of the
// drawing (read with pdf.js) and, optionally, in the markups. The results are listed in the panel
// and highlighted on the plan.

export interface SearchHit {
  id: number;
  pageIndex: number;
  rects: Rect[];                   // page coordinates (highlight on the plan)
  before: string;                  // text around the match, for the results list
  match: string;
  after: string;
  source: 'text' | 'markup';
}

// Text of one page and where each piece is on the page
export interface TextWord {
  str: string;
  rect: Rect;              // page coordinates
  line: number;            // words of the same line share it
  order: number;           // reading order
}

interface PageText {
  text: string;
  spans: { start: number; end: number; str: string; transform: number[]; width: number; height: number }[];
}

interface TextPiece { str: string; transform: number[]; width: number; height: number; hasEOL: boolean; }

const MAX_HITS = 2000;

@Injectable({ providedIn: 'root' })
export class TextSearch {
  private readonly store = inject(DrawingStore);

  readonly query = signal('');
  readonly scope = signal<'document' | 'page'>('document');
  readonly searchText = signal(true);
  readonly searchMarkups = signal(false);
  readonly caseSensitive = signal(false);
  readonly wholeWords = signal(false);

  readonly results = signal<SearchHit[]>([]);
  readonly focused = signal<SearchHit | null>(null);
  // The plan zooms to this region of the active pane (n changes on every request)
  readonly focusRequest = signal<{ rect: Rect; n: number } | null>(null);
  readonly busy = signal(false);
  readonly progress = signal('');
  readonly searched = signal(false);       // a search ran (shows "No results")
  readonly truncated = signal(false);
  // Results ticked in the list (ids): the actions menu works on them
  readonly checked = signal<ReadonlySet<number>>(new Set());

  private cacheOwner: unknown = null;
  // Keyed by the page itself, so moved, inserted or replaced (Slip Sheet) pages read their own text
  private cache = new WeakMap<object, Promise<PageText>>();
  private run = 0;
  private nextId = 0;

  constructor() {
    // Another drawing: the old results and the cached text go away
    effect(() => {
      const renderer = this.store.watch().renderer;
      untracked(() => {
        if (renderer !== this.cacheOwner) {
          this.cacheOwner = renderer;
          this.cache = new WeakMap();
          this.clear();
        }
      });
    });
  }

  clear(): void {
    this.run++;
    this.results.set([]);
    this.focused.set(null);
    this.busy.set(false);
    this.progress.set('');
    this.searched.set(false);
    this.truncated.set(false);
    this.checked.set(new Set());
  }

  async search(): Promise<void> {
    const runId = ++this.run;
    const s = this.store;
    const regex = this.regex();
    this.results.set([]);
    this.focused.set(null);
    this.truncated.set(false);
    this.checked.set(new Set());
    if (!regex || !s.hasDocument) {
      this.searched.set(false);
      return;
    }
    this.busy.set(true);
    const pages = this.scope() === 'page'
      ? [s.currentPageIndex]
      : Array.from({ length: s.pageCount }, (_, i) => i);
    const hits: SearchHit[] = [];

    for (const pageIndex of pages) {
      if (runId !== this.run) return;
      this.progress.set(`Searching page ${pageIndex + 1} of ${s.pageCount}…`);
      if (this.searchText()) {
        const text = await this.pageText(pageIndex);
        if (runId !== this.run) return;
        for (const match of text.text.matchAll(regex)) {
          if (!match[0]) continue;
          hits.push(this.hitFor(text, pageIndex, match.index ?? 0, match[0].length));
          if (hits.length >= MAX_HITS) break;
        }
      }
      if (this.searchMarkups()) {
        for (const el of s.elementsOn(pageIndex)) {
          const name = el instanceof Measurement ? s.itemFor(el)?.name ?? el.name : el.name;
          const text = [name, el.contents].filter(Boolean).join(' — ');
          regex.lastIndex = 0;
          const match = regex.exec(text);
          if (!match) continue;
          const i = match.index;
          hits.push({
            id: this.nextId++, pageIndex, rects: [el.bounds], source: 'markup',
            before: text.slice(0, i), match: match[0], after: text.slice(i + match[0].length),
          });
        }
        regex.lastIndex = 0;
      }
      this.results.set([...hits]);
      if (hits.length >= MAX_HITS) {
        this.truncated.set(true);
        break;
      }
    }
    this.busy.set(false);
    this.progress.set('');
    this.searched.set(true);
    if (hits.length) this.focus(hits[0]);
  }

  // Shows a result on the plan: goes to its page and zooms to it
  focus(hit: SearchHit): void {
    this.focused.set(hit);
    if (this.store.currentPageIndex !== hit.pageIndex) this.store.goTo(hit.pageIndex);
    const rect = boundsOf(hit.rects.flatMap(r => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]));
    this.focusRequest.set({ rect, n: hit.id + Math.random() });
  }

  // Next / previous result (wraps around)
  step(delta: number): void {
    const list = this.results();
    if (!list.length) return;
    const i = list.indexOf(this.focused() as SearchHit);
    this.focus(list[(i + delta + list.length) % list.length]);
  }

  // MARK: - Ticked results
  isChecked(hit: SearchHit): boolean { return this.checked().has(hit.id); }

  toggle(hit: SearchHit): void {
    const next = new Set(this.checked());
    if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id);
    this.checked.set(next);
  }

  setAll(on: boolean): void {
    this.checked.set(on ? new Set(this.results().map(h => h.id)) : new Set());
  }

  toggleGroup(hits: SearchHit[], on: boolean): void {
    const next = new Set(this.checked());
    for (const h of hits) if (on) next.add(h.id); else next.delete(h.id);
    this.checked.set(next);
  }

  checkedHits(): SearchHit[] {
    const ids = this.checked();
    return this.results().filter(h => ids.has(h.id));
  }

  // Trash button: the ticked results leave the list (nothing changes in the drawing)
  removeChecked(): void {
    const ids = this.checked();
    this.results.update(list => list.filter(h => !ids.has(h.id)));
    if (this.focused() && ids.has(this.focused()!.id)) this.focused.set(null);
    this.checked.set(new Set());
  }

  // MARK: - Actions on the ticked results (like Revu's lightning menu)
  // Highlight, Underline, Squiggly, StrikeOut or Redact over the text of every ticked result
  markChecked(subtype: 'Highlight' | 'Underline' | 'Squiggly' | 'StrikeOut' | 'Redact'): number {
    const titles = { Highlight: 'Highlight', Underline: 'Underline', Squiggly: 'Squiggly', StrikeOut: 'Strikethrough', Redact: 'Redaction' };
    const colors = { Highlight: '#FFFF00', Underline: COLORS.blue, Squiggly: COLORS.red, StrikeOut: COLORS.red, Redact: COLORS.red };
    return this.addMarkups(hit => {
      const m = this.newMarkup(hit, subtype, titles[subtype]);
      m.color = colors[subtype];
      if (subtype === 'Highlight') m.multiply = true;
      return m;
    });
  }

  // A link on every ticked result: to a web address or to a page of the drawing
  linkChecked(target: { uri: string } | { page: number }): number {
    return this.addMarkups(hit => {
      const m = this.newMarkup(hit, 'Link', 'Hyperlink');
      m.color = COLORS.blue;
      if ('uri' in target) m.uri = target.uri; else m.destPage = target.page;
      m.contents = 'uri' in target ? target.uri : `Page ${target.page + 1}`;
      return m;
    });
  }

  // A count of `itemId` in the middle of every ticked result (one Undo step)
  countChecked(itemId: string): number {
    const s = this.store;
    const item = s.items.find(i => i.id === itemId);
    const hits = this.checkedHits();
    if (!item || !hits.length) return 0;
    s.checkpoint();
    for (const hit of hits) {
      const b = this.boundsOf(hit);
      const m = new Measurement('count', hit.pageIndex, item.id);
      m.name = item.name;
      m.lineColor = item.color;
      m.visible = item.isVisible;
      m.points = [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }];
      m.contents = '1 ea';
      s.measurements.push(m);
    }
    s.touch();
    s.showToast(`Added ${hits.length} ${item.name} count${hits.length === 1 ? '' : 's'}`);
    return hits.length;
  }

  private addMarkups(make: (hit: SearchHit) => Markup): number {
    const s = this.store;
    const hits = this.checkedHits();
    if (!hits.length) return 0;
    s.checkpoint();
    const made = hits.map(make);
    made.forEach(m => m.updateRect());
    s.markups.push(...made);
    s.touch();
    s.showToast(`Added ${made.length} ${made[0].subject} markup${made.length === 1 ? '' : 's'}`);
    return made.length;
  }

  private newMarkup(hit: SearchHit, subtype: string, subject: string): Markup {
    const m = new Markup(hit.pageIndex);
    m.appMade = true;
    m.dirty = true;
    m.subtype = subtype;
    m.subject = subject;
    m.author = 'CadrafterPro';
    m.lineWidth = 1;
    m.contents = subtype === 'Link' ? '' : hit.match;
    m.quads = hit.rects.map(r => ({ ...r }));
    return m;
  }

  private boundsOf(hit: SearchHit): Rect {
    return boundsOf(hit.rects.flatMap(r => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]));
  }

  // The query as a regular expression: spaces match any run of spaces or line breaks
  private regex(): RegExp | null {
    const q = this.query().trim();
    if (!q) return null;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = this.wholeWords() ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    return new RegExp(pattern, this.caseSensitive() ? 'gu' : 'giu');
  }

  private hitFor(text: PageText, pageIndex: number, start: number, length: number): SearchHit {
    const end = start + length;
    const rects: Rect[] = [];
    for (const span of text.spans) {
      if (span.end <= start || span.start >= end) continue;
      // Where the match starts and ends inside the piece, measured in Helvetica (close to most drawing fonts)
      const total = textWidth(span.str, 10) || 1;
      const from = textWidth(span.str.slice(0, Math.max(start, span.start) - span.start), 10) / total;
      const to = textWidth(span.str.slice(0, Math.min(end, span.end) - span.start), 10) / total;
      rects.push(pieceRect(span, from, to));
    }
    const clean = (s: string) => s.replace(/\s+/g, ' ');
    return {
      id: this.nextId++, pageIndex, rects, source: 'text',
      before: clean(text.text.slice(Math.max(0, start - 40), start)).trimStart(),
      match: clean(text.text.slice(start, end)),
      after: clean(text.text.slice(end, end + 40)).trimEnd(),
    };
  }

  // Pieces of text of a page with their box in page coordinates (the AI assistant uses them
  // to place counts exactly on tags and labels)
  async pageWords(pageIndex: number): Promise<{ str: string; rect: Rect }[]> {
    const text = await this.pageText(pageIndex);
    return text.spans
      .filter(span => span.str.trim())
      .map(span => ({ str: span.str.trim(), rect: pieceRect(span, 0, 1) }));
  }

  // Words of a page in reading order with their box (page coordinates) and their line number,
  // for the Select Text tool
  async pageTextWords(pageIndex: number): Promise<TextWord[]> {
    const text = await this.pageText(pageIndex);
    const words: TextWord[] = [];
    let line = 0;
    let previousEnd = 0;
    for (const span of text.spans) {
      // A line break between the last piece and this one starts a new line
      if (words.length && text.text.slice(previousEnd, span.start).includes('\n')) line++;
      previousEnd = span.end;
      const length = span.str.length || 1;
      for (const match of span.str.matchAll(/\S+/g)) {
        const from = (match.index ?? 0) / length;
        const to = ((match.index ?? 0) + match[0].length) / length;
        words.push({ str: match[0], rect: pieceRect(span, from, to), line, order: words.length });
      }
    }
    return words;
  }

  // Text of a page in reading order, with a space or a line break where pieces don't touch
  private pageText(pageIndex: number): Promise<PageText> {
    const key = this.store.pages[pageIndex];
    if (!key) return Promise.resolve({ text: '', spans: [] });
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.readPage(pageIndex);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async readPage(pageIndex: number): Promise<PageText> {
    const page = this.store.pages[pageIndex]?.page;
    const result: PageText = { text: '', spans: [] };
    if (!page) return result;
    let content: { items: unknown[] };
    try {
      content = await page.getTextContent();
    } catch {
      return result;
    }
    let previous: TextPiece | null = null;
    for (const raw of content.items) {
      const item = raw as Partial<TextPiece>;
      if (typeof item.str !== 'string' || !item.transform) continue;
      const piece = item as TextPiece;
      if (piece.str.length > 0) {
        if (previous && result.text && !/\s$/.test(result.text) && !/^\s/.test(piece.str)) {
          result.text += separator(previous, piece);
        }
        result.spans.push({
          start: result.text.length, end: result.text.length + piece.str.length, str: piece.str,
          transform: piece.transform, width: piece.width, height: piece.height,
        });
        result.text += piece.str;
        previous = piece;
      }
      if (piece.hasEOL) {
        result.text += '\n';
        previous = null;
      }
    }
    return result;
  }
}

// Nothing, a space or a line break between two pieces of text, from where they are on the page
function separator(a: TextPiece, b: TextPiece): string {
  const [ta, tb] = [a.transform, b.transform];
  const scale = Math.hypot(ta[0], ta[1]) || 1;
  const u = { x: ta[0] / scale, y: ta[1] / scale };
  const end = { x: ta[4] + u.x * a.width, y: ta[5] + u.y * a.width };
  const size = Math.max(a.height || Math.hypot(ta[2], ta[3]), 1);
  // Distance along the line and across it
  const dx = tb[4] - end.x, dy = tb[5] - end.y;
  const along = dx * u.x + dy * u.y;
  const across = -dx * u.y + dy * u.x;
  if (Math.abs(across) > size * 0.5) return '\n';
  return Math.abs(along) > size * 0.15 ? ' ' : '';
}

// Box of the part [from, to] (0 to 1) of a piece of text, in page coordinates
function pieceRect(span: { transform: number[]; width: number; height: number }, from: number, to: number): Rect {
  const t = span.transform;
  const su = Math.hypot(t[0], t[1]) || 1;
  const sv = Math.hypot(t[2], t[3]) || 1;
  const u = { x: t[0] / su, y: t[1] / su };
  const v = { x: t[2] / sv, y: t[3] / sv };
  const h = span.height || sv;
  const o = { x: t[4], y: t[5] };
  const at = (x: number, y: number): Pt => ({ x: o.x + u.x * x + v.x * y, y: o.y + u.y * x + v.y * y });
  const x0 = span.width * from, x1 = span.width * to;
  return boundsOf([at(x0, -0.22 * h), at(x1, -0.22 * h), at(x0, 0.92 * h), at(x1, 0.92 * h)]);
}
