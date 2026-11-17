import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ICON_PATHS } from './icons';

// Icon drawn as inline SVG (no icon font, works offline). Its size is the font size of the
// element (the .icon classes set it) and its color is the text color.
//   <app-icon class="icon small" name="delete" />
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg viewBox="0 -960 960 960" aria-hidden="true" focusable="false"><path [attr.d]="path()" /></svg>`,
  styles: [`
    :host { display: inline-block; width: 1em; height: 1em; line-height: 0; flex: none; vertical-align: middle; }
    svg { width: 100%; height: 100%; fill: currentColor; display: block; }
  `],
})
export class Icon {
  readonly name = input('');
  readonly path = computed(() => ICON_PATHS[this.name()] ?? '');
}
