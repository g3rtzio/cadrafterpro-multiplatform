import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { PROPERTY_GROUPS, PropertyDef, PropType, evaluate, formatResult } from '../../models/estimate';
import { DrawingStore } from '../../services/drawing.store';

// Properties window of an element or a Part (PlanSwift style): every property with its
// formula and calculated result, by group. Formulas are edited in place; double-clicking a
// formula opens the Formula Editor, double-clicking the rest of a row (or "+") opens Edit Property.
// A property name can be dragged onto a formula. [..] copies the same property of the parent.
@Component({
  selector: 'app-properties-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dialog-backdrop', '(keydown.escape)': 'escape()' },
  template: `
    <div class="dialog wide">
      <h2>Properties: {{ title() }}</h2>
      <div class="props-toolbar">
        <button class="icon-button" title="New Property" (click)="newProperty()"><span class="icon">add</span></button>
        <button class="icon-button" title="Edit Property" [disabled]="selected() === null" (click)="editSelected()">
          <span class="icon">edit</span>
        </button>
        <button class="icon-button" title="Delete Property" [disabled]="!canDelete()" (click)="deleteSelected()">
          <span class="icon">delete</span>
        </button>
        <span class="secondary small">[Name] uses another property, [..] the same property of the parent</span>
      </div>
      <div class="props-scroll">
        <table class="props-table">
          <thead>
            <tr><th>Name</th><th>Formula</th><th>Input Units</th><th class="num">Result</th><th>Output Units</th></tr>
          </thead>
          <tbody>
            @for (group of groups(); track group.name) {
              <tr class="props-group" (click)="toggleGroup(group.name)">
                <td colspan="5">
                  <span class="icon small">{{ closedGroups().has(group.name) ? 'chevron_right' : 'expand_more' }}</span>
                  {{ group.name }}
                </td>
              </tr>
              @if (!closedGroups().has(group.name)) {
                @for (row of group.rows; track row.index) {
                  <tr [class.selected]="selected() === row.index" (click)="selected.set(row.index)"
                      (dblclick)="edit(row.index)">
                    <!-- Drag a name onto a formula to insert [Name] -->
                    <td class="indent prop-name" draggable="true" title="Drag onto a formula to use this property"
                        (dragstart)="dragProperty(row.prop, $event)">{{ row.prop.name }}</td>
                    <td>
                      @if (row.prop.takeoff) {
                        <span class="secondary small">From the plan</span>
                      } @else {
                        <!-- Double-click: Formula Editor -->
                        <input class="formula" [value]="row.prop.formula"
                               (dblclick)="$event.stopPropagation(); openFormula(row.index)"
                               (dragover)="$event.preventDefault()" (drop)="dropOnFormula(row.index, $event)"
                               (input)="setFormula(row.index, $event)" />
                      }
                    </td>
                    <td>{{ row.prop.inputUnits }}</td>
                    <td class="num result" [class.error]="!!row.error" [title]="row.error ?? ''">{{ row.result }}</td>
                    <td>{{ row.units }}</td>
                  </tr>
                }
              }
            }
          </tbody>
        </table>
      </div>
      <div class="dialog-buttons">
        <button type="button" (click)="store.closeProperties()">Cancel</button>
        <button type="button" class="primary" (click)="ok()">Ok</button>
      </div>
    </div>

    <!-- Formula Editor: operators, properties of the row (click or drag) and the result while typing -->
    @if (formulaEditor(); as f) {
      <div class="dialog-backdrop" (click)="$event.stopPropagation()">
        <div class="dialog formula-dialog">
          <h2>Formula Editor: {{ draft()[f.index].name }}</h2>
          <div class="props-toolbar">
            @for (op of operators; track op) {
              <button type="button" class="op-button" (mousedown)="$event.preventDefault()" (click)="insert(op)">{{ op.trim() }}</button>
            }
            <button type="button" class="op-button" title="Same property of the parent"
                    (mousedown)="$event.preventDefault()" (click)="insert('[..]')">[..]</button>
          </div>
          <div class="formula-body">
            <textarea #formulaBox class="formula-text" [value]="f.text" spellcheck="false"
                      (input)="setEditorText($event)" (dragover)="$event.preventDefault()"
                      (drop)="dropInEditor($event)" autofocus></textarea>
            <div class="formula-props">
              <div class="secondary small">Properties (click or drag)</div>
              @for (p of draft(); track $index) {
                @if ($index !== f.index) {
                  <div class="formula-prop" draggable="true" (dragstart)="dragProperty(p, $event)"
                       (mousedown)="$event.preventDefault()" (click)="insert('[' + p.name + ']')">{{ p.name }}</div>
                }
              }
            </div>
          </div>
          <div class="formula-result">Result: <b [class.error-text]="!!editorResult().error">{{ editorResult().text }}</b>
            @if (editorResult().error) { <span class="error-text"> {{ editorResult().error }}</span> }
          </div>
          <div class="dialog-buttons">
            <button type="button" (click)="formulaEditor.set(null)">Cancel</button>
            <button type="button" class="primary" (click)="saveFormula()">Ok</button>
          </div>
        </div>
      </div>
    }

    <!-- Edit Property: a new property ("+") or the one double-clicked -->
    @if (editor(); as e) {
      <div class="dialog-backdrop" (click)="$event.stopPropagation()">
        <form class="dialog" (submit)="$event.preventDefault(); saveEditor()">
          <h2>{{ e.index === null ? 'New Property' : 'Edit Property' }}</h2>
          <label class="field">Name
            <input [value]="e.prop.name" (input)="patch({ name: text($event) })" autofocus />
          </label>
          <div class="field-row">
            <label class="field">Type
              <select (change)="patch({ type: $any(text($event)) })">
                @for (t of types; track t) { <option [value]="t" [selected]="e.prop.type === t">{{ t === 'number' ? 'Number' : 'Text' }}</option> }
              </select>
            </label>
            <label class="field">Group
              <input list="property-groups" [value]="e.prop.group" (input)="patch({ group: text($event) })" />
            </label>
          </div>
          <datalist id="property-groups">
            @for (g of groupNames(); track g) { <option [value]="g"></option> }
          </datalist>
          <label class="field">Formula
            <input [value]="e.prop.formula" [disabled]="!!e.prop.takeoff" (input)="patch({ formula: text($event) })" />
          </label>
          <div class="field-row">
            <label class="field">Input Units
              <input [value]="e.prop.inputUnits" (input)="patch({ inputUnits: text($event) })" />
            </label>
            <label class="field">Units
              <input [value]="e.prop.units" (input)="patch({ units: text($event) })" />
            </label>
            <label class="field">Decimal Places
              <input type="number" min="0" max="8" class="num-input" [value]="e.prop.decimals"
                     (input)="patch({ decimals: clampDecimals(text($event)) })" />
            </label>
          </div>
          @if (editorError()) { <p class="error-text">{{ editorError() }}</p> }
          <div class="dialog-buttons">
            <button type="button" (click)="editor.set(null)">Cancel</button>
            <button type="submit" class="primary" [disabled]="!!editorError()">Ok</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class PropertiesDialog implements OnInit {
  readonly store = inject(DrawingStore);
  readonly rowKey = input.required<string>();
  readonly types: PropType[] = ['number', 'text'];

  readonly draft = signal<PropertyDef[]>([]);                // the properties being edited
  readonly selected = signal<number | null>(null);           // index in draft
  readonly closedGroups = signal(new Set<string>());
  readonly editor = signal<{ index: number | null; prop: PropertyDef } | null>(null);
  readonly formulaEditor = signal<{ index: number; text: string } | null>(null);
  readonly formulaBox = viewChild<ElementRef<HTMLTextAreaElement>>('formulaBox');
  readonly operators = [' + ', ' - ', ' * ', ' / ', '(', ')'];

  ngOnInit(): void {
    this.draft.set(structuredClone(this.store.rowProps(this.rowKey())));
  }

  readonly title = computed(() => {
    const name = this.draft().find(p => p.name === 'Name');
    return name?.formula || this.rowKey();
  });

  // Groups in the usual order, then any group the user made
  readonly groupNames = computed(() => {
    const names = [...PROPERTY_GROUPS];
    for (const p of this.draft()) if (p.group && !names.includes(p.group)) names.push(p.group);
    return names;
  });

  // Rows with their results, calculated from the draft (results follow the formulas as you type)
  readonly groups = computed(() => {
    this.store.watch();
    const props = this.draft();
    const node = this.store.evalNode(this.rowKey(), props);
    const rows = props.map((prop, index) => {
      const r = evaluate(node, prop.name);
      return { index, prop, result: formatResult(r, prop.decimals), units: r.units, error: r.error };
    });
    return this.groupNames()
      .map(name => ({ name, rows: rows.filter(r => (r.prop.group || 'Item') === name) }))
      .filter(g => g.rows.length > 0);
  });

  // Name and Type are fixed; measured values come from the plan
  readonly canDelete = computed(() => {
    const i = this.selected();
    const p = i === null ? null : this.draft()[i];
    return !!p && !p.takeoff && p.name !== 'Name' && p.name !== 'Type';
  });

  readonly editorError = computed(() => {
    const e = this.editor();
    if (!e) return '';
    const name = e.prop.name.trim();
    if (!name) return 'The property needs a name';
    if (/[[\]]/.test(name)) return 'The name can\'t have [ or ]';
    const taken = this.draft().some((p, i) => i !== e.index && p.name.trim().toLowerCase() === name.toLowerCase());
    return taken ? `There is already a property "${name}"` : '';
  });

  text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  clampDecimals(value: string): number {
    return Math.max(0, Math.min(8, Math.round(Number(value) || 0)));
  }

  toggleGroup(name: string): void {
    this.closedGroups.update(set => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  setFormula(index: number, event: Event): void {
    const formula = this.text(event);
    this.draft.update(list => list.map((p, i) => i === index ? { ...p, formula } : p));
  }

  // MARK: - Formula Editor
  openFormula(index: number): void {
    if (this.draft()[index]?.takeoff) return;
    this.selected.set(index);
    this.formulaEditor.set({ index, text: this.draft()[index].formula });
    setTimeout(() => this.formulaBox()?.nativeElement.focus(), 0);
  }

  // Result of the formula being edited, with the other properties as they are in the window
  readonly editorResult = computed(() => {
    const f = this.formulaEditor();
    if (!f) return { text: '', error: undefined as string | undefined };
    this.store.watch();
    const props = this.draft().map((p, i) => i === f.index ? { ...p, formula: f.text } : p);
    const r = evaluate(this.store.evalNode(this.rowKey(), props), props[f.index].name);
    return { text: formatResult(r, props[f.index].decimals) + (r.units ? ' ' + r.units : ''), error: r.error };
  });

  setEditorText(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.formulaEditor.update(f => f && { ...f, text });
  }

  // Operator or [Property] at the cursor of the formula box
  insert(piece: string): void {
    const box = this.formulaBox()?.nativeElement;
    const f = this.formulaEditor();
    if (!box || !f) return;
    const start = box.selectionStart ?? f.text.length;
    const end = box.selectionEnd ?? start;
    const text = f.text.slice(0, start) + piece + f.text.slice(end);
    this.formulaEditor.set({ ...f, text });
    box.value = text;
    box.setSelectionRange(start + piece.length, start + piece.length);
    box.focus();
  }

  saveFormula(): void {
    const f = this.formulaEditor();
    if (!f) return;
    this.draft.update(list => list.map((p, i) => i === f.index ? { ...p, formula: f.text.trim() } : p));
    this.formulaEditor.set(null);
  }

  // Dragging a property name: drops as [Name] in a formula field
  dragProperty(prop: PropertyDef, event: DragEvent): void {
    event.dataTransfer?.setData('text/plain', `[${prop.name}]`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }

  // A property dropped on a formula of the grid: added at the end of the formula
  dropOnFormula(index: number, event: DragEvent): void {
    const piece = event.dataTransfer?.getData('text/plain');
    if (!piece) return;
    event.preventDefault();
    this.selected.set(index);
    this.draft.update(list => list.map((p, i) => i === index ? { ...p, formula: p.formula + piece } : p));
  }

  // A property dropped in the Formula Editor: inserted at the cursor
  dropInEditor(event: DragEvent): void {
    const piece = event.dataTransfer?.getData('text/plain');
    if (!piece) return;
    event.preventDefault();
    this.insert(piece);
  }

  // MARK: - Edit Property
  newProperty(): void {
    const i = this.selected();
    const group = i !== null ? this.draft()[i]?.group ?? 'Item' : 'Item';
    this.editor.set({
      index: null,
      prop: { name: '', group, type: 'number', formula: '', inputUnits: '', units: '', decimals: 2 },
    });
  }

  edit(index: number): void {
    this.selected.set(index);
    this.editor.set({ index, prop: { ...this.draft()[index] } });
  }

  editSelected(): void {
    const i = this.selected();
    if (i !== null) this.edit(i);
  }

  patch(change: Partial<PropertyDef>): void {
    this.editor.update(e => e && { ...e, prop: { ...e.prop, ...change } });
  }

  // Ok in Edit Property: a new property goes at the end of its group
  saveEditor(): void {
    const e = this.editor();
    if (!e || this.editorError()) return;
    const prop: PropertyDef = { ...e.prop, name: e.prop.name.trim(), group: e.prop.group.trim() || 'Item' };
    const list = [...this.draft()];
    if (e.index !== null) {
      list[e.index] = prop;
      this.selected.set(e.index);
    } else {
      let at = -1;
      list.forEach((p, i) => { if (p.group === prop.group) at = i; });
      at = at < 0 ? list.length : at + 1;
      list.splice(at, 0, prop);
      this.selected.set(at);
      this.closedGroups.update(set => { const next = new Set(set); next.delete(prop.group); return next; });
    }
    this.draft.set(list);
    this.editor.set(null);
  }

  deleteSelected(): void {
    const i = this.selected();
    if (i === null || !this.canDelete()) return;
    this.draft.update(list => list.filter((_, n) => n !== i));
    this.selected.set(null);
  }

  // MARK: - Window
  escape(): void {
    if (this.formulaEditor()) this.formulaEditor.set(null);
    else if (this.editor()) this.editor.set(null);
    else this.store.closeProperties();
  }

  ok(): void {
    this.store.applyProperties(this.rowKey(), this.draft());
  }
}
