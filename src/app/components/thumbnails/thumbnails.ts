import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, input, signal,
  viewChild,
} from '@angular/core';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { renderRegion } from '../../services/pdf-render/pdf-render';
import { pageShapes } from '../../services/shapes/shapes';
import { PageLabeler } from '../../services/page-labels/page-labels';
import { InsertPagesDialog } from '../insert-pages-dialog/insert-pages-dialog';
import { PageLabelsDialog } from '../page-labels-dialog/page-labels-dialog';
import { SvgShapes } from '../svg-shapes/svg-shapes';
import { Icon } from '../icon/icon';

const THUMB_WIDTH = 180;
const PAGE_DRAG_TYPE = 'application/x-cadrafter-pages';

// One page picture, drawn when it scrolls into view, with the measurements on top
@Component({
  selector: 'app-page-thumb',
  imports: [SvgShapes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'thumb', '[class.current]': 'isCurrent()', '[class.selected]': 'selected()' },
  template: `
    @if (geometry(); as g) {
      <div class="thumb-page" [style.aspect-ratio]="g.width + ' / ' + g.height">
        <canvas #canvas></canvas>
        @if (visible()) {
          <svg [attr.viewBox]="'0 0 ' + g.width + ' ' + g.height" preserveAspectRatio="none">
            <g [appShapes]="shapes()"></g>
          </svg>
        }
      </div>
    }
    <div class="thumb-title">{{ store.watch().pageName(index()) }}</div>
  `,
})
export class PageThumb implements OnDestroy {
  readonly store = inject(DrawingStore);
  readonly index = input.required<number>();
  readonly selected = input(false);
  private readonly element = inject(ElementRef<HTMLElement>);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly visible = signal(false);
  private observer?: IntersectionObserver;
  private drawn: unknown = null;

  readonly geometry = computed(() => this.store.watch().pages[this.index()] ?? null);
  readonly isCurrent = computed(() => this.store.watch().currentPageIndex === this.index());
  // Reading the store here redraws the measurements when they change
  readonly shapes = computed(() => {
    const s = this.store.watch();
    const g = this.geometry();
    return g ? pageShapes(s, this.index(), g, THUMB_WIDTH / g.width, false) : [];
  });

  constructor() {
    afterNextRender(() => {
      this.observer = new IntersectionObserver(entries => this.visible.set(entries[0].isIntersecting), { rootMargin: '300px' });
      this.observer.observe(this.element.nativeElement);
    });
    // Draws the page the first time it is visible
    effect(() => {
      const g = this.geometry();
      const canvas = this.canvas()?.nativeElement;
      if (!g || !canvas || !this.visible() || this.drawn === g) return;
      this.drawn = g;
      const scale = (THUMB_WIDTH * 2) / g.width;          // ×2 for Retina
      renderRegion(g.page, { x: 0, y: 0, w: g.width, h: g.height }, scale).then(result => {
        if (!result || this.drawn !== g) return;
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d')?.drawImage(result, 0, 0);
      });
    });
    // The page in the plan scrolls into view
    effect(() => {
      if (this.isCurrent()) this.element.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}

// "Pages" sidebar — port of ThumbnailsView.swift, plus page management (like Revu's Thumbnails):
// add a blank page, insert pages from another PDF, delete, and reorder by dragging.
// Click = go to the page, Ctrl/⌘ + click = add to the selection, Shift + click = a range.
@Component({
  selector: 'app-thumbnails',
  imports: [Icon, InsertPagesDialog, PageLabelsDialog, PageThumb],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'thumbnails',
    tabindex: '-1',
    '(keydown)': 'onKey($event)',
    '(document:click)': 'menu.set(null)',
  },
  styles: [`
    :host { display: flex !important; flex-direction: column; padding: 0 !important; overflow: hidden !important; outline: none; }
    .page-tools { display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
    .page-tools .count { margin-left: auto; font-size: 11px; color: var(--secondary); }
    .page-list { flex: 1; overflow-y: auto; padding: 12px; }
    .slot { position: relative; }
    .slot.drop-before::before, .slot.drop-after::after {
      content: ""; position: absolute; left: 8px; right: 8px; height: 3px; border-radius: 2px; background: var(--accent);
    }
    .slot.drop-before::before { top: -8px; }
    .slot.drop-after::after { bottom: 6px; }
    app-page-thumb.selected .thumb-page { outline: 3px solid var(--accent); }
    app-page-thumb.selected:not(.current) .thumb-page { outline-style: dashed; }
    .list-end { height: 24px; }
    .page-menu { position: fixed; z-index: 120; top: auto; left: auto; }
  `],
  template: `
    @let s = store.watch();
    <div class="page-tools">
      <button class="icon-button" title="Insert a blank page after this one" [disabled]="!s.hasDocument"
              (click)="s.insertBlankPage(s.currentPageIndex + 1)"><app-icon class="icon small" name="note_add" /></button>
      <button class="icon-button" title="Insert pages from another PDF…" [disabled]="!s.hasDocument"
              (click)="pickFile(s.currentPageIndex + 1)"><app-icon class="icon small" name="post_add" /></button>
      <button class="icon-button" title="Move up" [disabled]="!canMove(-1)" (click)="moveBy(-1)">
        <app-icon class="icon small" name="arrow_upward" /></button>
      <button class="icon-button" title="Move down" [disabled]="!canMove(1)" (click)="moveBy(1)">
        <app-icon class="icon small" name="arrow_downward" /></button>
      <button class="icon-button" title="Delete the selected pages" [disabled]="s.pageCount < 2"
              (click)="deleteSelected()"><app-icon class="icon small" name="delete" /></button>
      <button class="icon-button" title="Create Page Labels: name the pages from bookmarks or from a region"
              [disabled]="!s.hasDocument" (click)="labeler.open()"><app-icon class="icon small" name="label" /></button>
      <span class="count">{{ selectedList().length > 1 ? selectedList().length + ' of ' : '' }}{{ s.pageCount }} pages</span>
    </div>

    <div class="page-list" (dragover)="onListDragOver($event)" (drop)="onDrop($event)" (dragleave)="onDragLeave($event)">
      @for (page of s.pages; track page; let i = $index) {
        <div class="slot" [class.drop-before]="dropAt() === i" [class.drop-after]="dropAt() === s.pageCount && i === s.pageCount - 1"
             draggable="true" (dragstart)="onDragStart($event, i)" (dragend)="onDragEnd()"
             (dragover)="onDragOver($event, i)" (click)="onClick($event, i)" (contextmenu)="openMenu($event, i)">
          <app-page-thumb [index]="i" [selected]="isSelected(i)" />
        </div>
      }
      <div class="list-end"></div>
    </div>

    <!-- Right click on a page -->
    @if (menu(); as m) {
      <div class="menu page-menu" [style.left.px]="m.x" [style.top.px]="m.y" (click)="$event.stopPropagation()">
        <button class="menu-item" (click)="menu.set(null); s.insertBlankPage(m.index)">Insert Blank Page Before</button>
        <button class="menu-item" (click)="menu.set(null); s.insertBlankPage(m.index + 1)">Insert Blank Page After</button>
        <button class="menu-item" (click)="menu.set(null); pickFile(m.index + 1)">Insert Pages from File…</button>
        <div class="menu-divider"></div>
        <button class="menu-item" [disabled]="selectedList()[0] === 0" (click)="menu.set(null); moveTo(0)">Move to Beginning</button>
        <button class="menu-item" [disabled]="selectedList()[selectedList().length - 1] === s.pageCount - 1"
                (click)="menu.set(null); moveTo(s.pageCount)">Move to End</button>
        <div class="menu-divider"></div>
        <button class="menu-item" (click)="menu.set(null); s.goTo(m.index); s.startOverlay()">Overlay with Another Page…</button>
        <button class="menu-item" (click)="menu.set(null); labeler.open()">Create Page Labels…</button>
        <div class="menu-divider"></div>
        <button class="menu-item destructive" [disabled]="s.pageCount < 2" (click)="menu.set(null); deleteSelected()">
          Delete {{ selectedList().length > 1 ? selectedList().length + ' Pages' : 'Page' }}
        </button>
      </div>
    }

    @if (labeler.dialogOpen() && !labeler.selecting()) { <app-page-labels-dialog /> }

    @for (request of s.insertRequest ? [s.insertRequest] : []; track request.id) {
      <app-insert-pages-dialog />
    }
  `,
})
export class Thumbnails {
  readonly store = inject(DrawingStore);
  readonly labeler = inject(PageLabeler);
  // Pages selected besides the current one (indexes); cleared whenever the pages change
  private readonly extra = signal<Set<number>>(new Set());
  private anchor: number | null = null;
  readonly dropAt = signal<number | null>(null);
  readonly menu = signal<{ x: number; y: number; index: number } | null>(null);
  private dragging: number[] | null = null;
  private pageList: unknown = null;

  // The current page is always selected
  readonly selectedList = computed(() => {
    const s = this.store.watch();
    if (s.pages !== this.pageList) return [s.currentPageIndex];
    return [...new Set([s.currentPageIndex, ...this.extra()])].filter(i => i < s.pageCount).sort((a, b) => a - b);
  });

  constructor() {
    // New page list (added, deleted, moved, another file): the selection starts over
    effect(() => {
      const pages = this.store.watch().pages;
      if (pages !== this.pageList) {
        this.pageList = pages;
        this.extra.set(new Set());
        this.anchor = null;
      }
    });
  }

  isSelected(i: number): boolean {
    return this.selectedList().includes(i);
  }

  onClick(event: MouseEvent, index: number): void {
    const s = this.store;
    if (event.shiftKey) {
      const from = this.anchor ?? s.currentPageIndex;
      const range = new Set<number>();
      for (let i = Math.min(from, index); i <= Math.max(from, index); i++) range.add(i);
      this.extra.set(range);
      s.goTo(index);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const set = new Set(this.selectedList());
      if (set.has(index) && set.size > 1) {
        set.delete(index);
        if (index === s.currentPageIndex) s.goTo([...set][0]);
      } else {
        set.add(index);
        s.goTo(index);
      }
      this.extra.set(set);
      this.anchor = index;
      return;
    }
    this.extra.set(new Set());
    this.anchor = index;
    s.goTo(index);
  }

  openMenu(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isSelected(index)) {
      this.extra.set(new Set());
      this.store.goTo(index);
    }
    this.menu.set({ x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 300), index });
  }

  // MARK: - Delete and move
  deleteSelected(): void {
    const list = this.selectedList();
    const s = this.store;
    if (list.length === 0 || s.pageCount < 2) return;
    const names = list.length === 1 ? s.pageName(list[0]) : `${list.length} pages`;
    if (!confirm(`Delete ${names}? Its measurements and markups are deleted too. This can't be undone.`)) return;
    s.deletePages(list);
  }

  canMove(step: number): boolean {
    const list = this.selectedList();
    const s = this.store.watch();
    if (!s.hasDocument || list.length === 0) return false;
    return step < 0 ? list[0] > 0 : list[list.length - 1] < s.pageCount - 1;
  }

  // One place up or down; the selection moves with the pages
  moveBy(step: number): void {
    if (!this.canMove(step)) return;
    const list = this.selectedList();
    const before = step < 0 ? list[0] - 1 : list[list.length - 1] + 2;
    this.moveTo(before);
  }

  moveTo(before: number, list = this.selectedList()): void {
    const s = this.store;
    const current = s.currentPageIndex;
    const firstNew = s.pages.map((_, i) => i).filter(i => !list.includes(i) && i < before).length;
    s.movePages(list, before);
    // Keep the moved pages selected and the page that was shown (it follows its new place)
    this.pageList = s.pages;
    const moved = list.map((_, k) => firstNew + k);
    this.extra.set(new Set(moved));
    s.goTo(moved[list.indexOf(current)] ?? moved[0]);
  }

  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      this.deleteSelected();
    }
  }

  // MARK: - Drag to reorder, drop a PDF to insert its pages
  onDragStart(event: DragEvent, index: number): void {
    this.dragging = this.isSelected(index) ? this.selectedList() : [index];
    event.dataTransfer?.setData(PAGE_DRAG_TYPE, String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragEnd(): void {
    this.dragging = null;
    this.dropAt.set(null);
  }

  onDragOver(event: DragEvent, index: number): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    this.dropAt.set(after ? index + 1 : index);
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.dragging ? 'move' : 'copy';
  }

  // Below the last page: drop at the end
  onListDragOver(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if ((event.target as HTMLElement).classList.contains('list-end')) this.dropAt.set(this.store.pageCount);
  }

  onDragLeave(event: DragEvent): void {
    const list = event.currentTarget as HTMLElement;
    if (!list.contains(event.relatedTarget as Node | null)) this.dropAt.set(null);
  }

  onDrop(event: DragEvent): void {
    const at = this.dropAt();
    this.dropAt.set(null);
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();                         // the window would open the PDF instead
    if (at === null) return;
    if (this.dragging) {
      const moving = this.dragging;
      this.dragging = null;
      this.moveTo(at, moving);
      return;
    }
    const file = [...(event.dataTransfer?.files ?? [])].find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (file) file.arrayBuffer().then(buffer => this.store.requestInsertPages(new Uint8Array(buffer), file.name, at));
  }

  private accepts(event: DragEvent): boolean {
    const types = event.dataTransfer?.types ?? [];
    return this.store.hasDocument && (!!this.dragging || types.includes(PAGE_DRAG_TYPE) || types.includes('Files'));
  }

  // MARK: - Insert pages from another PDF
  pickFile(at: number): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) await this.store.requestInsertPages(new Uint8Array(await file.arrayBuffer()), file.name, at);
    });
    input.click();
  }
}
