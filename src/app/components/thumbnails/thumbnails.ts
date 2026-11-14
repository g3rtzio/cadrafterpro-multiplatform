import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DrawingStore } from '../../services/drawing.store';
import { renderRegion } from '../../services/pdf-render';
import { pageShapes } from '../../services/shapes';
import { SvgShapes } from '../svg-shapes/svg-shapes';

const THUMB_WIDTH = 180;

// One page picture, drawn when it scrolls into view, with the measurements on top
@Component({
  selector: 'app-page-thumb',
  imports: [SvgShapes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'thumb', '[class.current]': 'isCurrent()', '(click)': 'store.goTo(index())' },
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
      this.observer = new IntersectionObserver(
        (entries) => this.visible.set(entries[0].isIntersecting),
        { rootMargin: '300px' },
      );
      this.observer.observe(this.element.nativeElement);
    });
    // Draws the page the first time it is visible
    effect(() => {
      const g = this.geometry();
      const canvas = this.canvas()?.nativeElement;
      if (!g || !canvas || !this.visible() || this.drawn === g) return;
      this.drawn = g;
      const scale = (THUMB_WIDTH * 2) / g.width; // ×2 for Retina
      renderRegion(g.page, { x: 0, y: 0, w: g.width, h: g.height }, scale).then((result) => {
        if (!result) return;
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d')?.drawImage(result, 0, 0);
      });
    });
    // The page in the plan scrolls into view
    effect(() => {
      if (this.isCurrent())
        this.element.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}

// "Pages" sidebar — port of ThumbnailsView.swift
@Component({
  selector: 'app-thumbnails',
  imports: [PageThumb],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'thumbnails' },
  template: `
    @for (page of store.watch().pages; track $index) {
      <app-page-thumb [index]="$index" />
    }
  `,
})
export class Thumbnails {
  readonly store = inject(DrawingStore);
}
