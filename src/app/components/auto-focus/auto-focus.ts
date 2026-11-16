import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

// Focuses (and selects the text of) a field as soon as it appears, e.g. a rename box
@Directive({ selector: '[appAutoFocus]' })
export class AutoFocus {
  constructor() {
    const el = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      el.focus();
      el.select?.();
    });
  }
}
