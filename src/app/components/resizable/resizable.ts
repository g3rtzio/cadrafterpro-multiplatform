import { Directive, ElementRef, OnDestroy, afterNextRender, inject, input } from '@angular/core';

// Lets the user change the width of a panel by dragging its edge. The width is remembered
// (localStorage) under `resizeKey`; a double click on the edge goes back to the normal width.
//   <aside class="sidebar" appResizable="right" resizeKey="sidebar">   → handle on the right edge
//   <aside appResizable="left" resizeKey="sidePanel">                  → handle on the left edge
@Directive({ selector: '[appResizable]' })
export class Resizable implements OnDestroy {
  readonly edge = input<'left' | 'right' | ''>('right', { alias: 'appResizable' });
  readonly resizeKey = input.required<string>();
  readonly minWidth = input(160);
  readonly maxWidth = input(800);

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private handle: HTMLDivElement | null = null;
  private cleanup: (() => void) | null = null;

  constructor() {
    afterNextRender(() => {
      const saved = Number(read(this.storageKey));
      if (saved) this.setWidth(saved);
      if (getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
      const handle = document.createElement('div');
      handle.className = `resize-handle ${this.side}`;
      handle.title = 'Drag to resize (double click: normal size)';
      handle.addEventListener('pointerdown', e => this.start(e));
      handle.addEventListener('dblclick', e => {
        e.stopPropagation();
        this.el.style.width = '';
        this.el.style.flexBasis = '';
        write(this.storageKey, null);
      });
      handle.addEventListener('click', e => e.stopPropagation());
      this.el.appendChild(handle);
      this.handle = handle;
    });
  }

  private get side(): 'left' | 'right' {
    return this.edge() === 'left' ? 'left' : 'right';
  }

  private get storageKey(): string {
    return `cadrafterpro.panelWidth.${this.resizeKey()}`;
  }

  private setWidth(width: number): number {
    const w = Math.round(Math.min(this.maxWidth(), Math.max(this.minWidth(), width)));
    this.el.style.width = `${w}px`;
    this.el.style.flexBasis = `${w}px`;
    return w;
  }

  private start(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = this.el.getBoundingClientRect().width;
    const sign = this.side === 'right' ? 1 : -1;
    let width = startWidth;
    document.body.classList.add('resizing-panel');
    const move = (ev: PointerEvent) => { width = this.setWidth(startWidth + sign * (ev.clientX - startX)); };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-panel');
      write(this.storageKey, String(width));
      this.cleanup = null;
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    this.cleanup = up;
  }

  ngOnDestroy(): void {
    this.cleanup?.();
    this.handle?.remove();
  }
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
}
