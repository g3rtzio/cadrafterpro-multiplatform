import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { EvalNode, PropertyDef } from '../../models/estimate';
import { scriptCode, isScriptFormula, isScriptTrusted, trustScripts } from '../../models/formula-script';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { PropsGrid } from '../props-grid/props-grid';

// Properties window of an element or a Part (PlanSwift style): the property grid with every
// formula and its result. Nothing changes in the estimate until Ok.
@Component({
  selector: 'app-properties-dialog',
  imports: [PropsGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'escape()' },
  template: `
    <div class="dialog wide">
      <h2>Properties: {{ title() }}</h2>
      <app-props-grid [props]="draft()" [evalNode]="node" (propsChange)="draft.set($event)" />
      <div class="dialog-buttons">
        <button type="button" (click)="store.closeProperties()">Cancel</button>
        <button type="button" class="primary" (click)="ok()">Ok</button>
      </div>
    </div>
  `,
})
export class PropertiesDialog implements OnInit {
  readonly store = inject(DrawingStore);
  readonly rowKey = input.required<string>();
  readonly draft = signal<PropertyDef[]>([]);                // the properties being edited
  private readonly grid = viewChild(PropsGrid);

  // Results follow the draft while editing
  readonly node = (props: PropertyDef[]): EvalNode => this.store.evalNode(this.rowKey(), props);

  ngOnInit(): void {
    this.draft.set(structuredClone(this.store.rowProps(this.rowKey())));
  }

  readonly title = computed(() => {
    const name = this.draft().find(p => p.name === 'Name');
    return name?.formula || this.rowKey();
  });

  escape(): void {
    if (!this.grid()?.closeInner()) this.store.closeProperties();
  }

  // JavaScript typed in this window is remembered as the user's own
  ok(): void {
    const own = this.draft().filter(p => isScriptFormula(p.formula)).map(p => scriptCode(p.formula)).filter(isScriptTrusted);
    trustScripts(own);
    this.store.applyProperties(this.rowKey(), this.draft());
  }
}
