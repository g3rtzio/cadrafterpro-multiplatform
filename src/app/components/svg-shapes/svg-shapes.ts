import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Shape } from '../../services/shapes/shapes';

// Draws a list of shapes inside an <svg> (used by the plan and by the page thumbnails)
@Component({
  selector: 'g[appShapes]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (s of shapes(); track $index) {
      @if (s.href) {
        <svg:image [attr.href]="s.href" [attr.x]="s.x" [attr.y]="s.y" [attr.width]="s.w" [attr.height]="s.h"
                   [attr.opacity]="s.opacity" preserveAspectRatio="none" />
      } @else if (s.text !== undefined) {
        <svg:text [attr.x]="s.x" [attr.y]="s.y" [attr.fill]="s.fill" [attr.opacity]="s.opacity"
                  [attr.font-size]="s.fontSize" [attr.font-family]="s.fontFamily"
                  [attr.font-weight]="s.fontWeight" [attr.font-style]="s.fontStyle"
                  [attr.text-anchor]="s.anchor" [attr.dominant-baseline]="s.baseline"
                  [attr.transform]="s.rotate ? 'rotate(' + s.rotate + ' ' + s.x + ' ' + s.y + ')' : null">{{ s.text }}</svg:text>
      } @else {
        <svg:path [attr.d]="s.d" [attr.fill]="s.fill" [attr.fill-opacity]="s.fillOpacity"
                  [attr.stroke]="s.stroke" [attr.stroke-width]="s.width" [attr.stroke-dasharray]="s.dash"
                  [attr.opacity]="s.opacity" stroke-linecap="round" stroke-linejoin="round"
                  [style.mix-blend-mode]="s.blend" />
      }
    }
  `,
})
export class SvgShapes {
  readonly shapes = input.required<Shape[]>({ alias: 'appShapes' });
}
