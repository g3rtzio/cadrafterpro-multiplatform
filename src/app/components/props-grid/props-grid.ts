import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { EvalNode, PROPERTY_GROUPS, PropertyDef, PropType, evaluate, formatResult } from '../../models/estimate';
import { isScriptFormula, isScriptTrusted, scriptCode, scriptsOf, toScriptFormula, trustScripts } from '../../models/formula-script';
import { convertUnits, findUnit, unitOptions } from '../../models/units';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

let nextGridId = 1;

// Property grid in the style of PlanSwift's Properties window, shared by the estimate (elements and
// parts), the Templates tab and the Cost Database. Every row: Name, Formula (with "…" to open the
// Formula Editor), Input Units, Result (converted from input to output units) and Output Units.
// The toolbar adds, edits, deletes and moves rows. Every change emits a new list (propsChange);
// the owner decides when to keep it (Ok in the estimate, right away in the libraries).
@Component({
  selector: 'app-props-grid',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'props-grid', '(keydown.escape)': 'escape($event)' },
  template: `
    <div class="props-toolbar">
      <button class="icon-button" title="Add Row" (click)="newProperty()"><app-icon class="icon" name="add" /></button>
      <button class="icon-button" title="Edit Row" [disabled]="selected() === null" (click)="editSelected()">
        <app-icon class="icon" name="edit" />
      </button>
      <button class="icon-button" title="Delete Row" [disabled]="!canDelete()" (click)="deleteSelected()">
        <app-icon class="icon" name="delete" />
      </button>
      <span class="toolbar-sep"></span>
      <button class="icon-button" title="Move Row Up" [disabled]="!canMove(-1)" (click)="move(-1)">
        <app-icon class="icon" name="arrow_upward" />
      </button>
      <button class="icon-button" title="Move Row Down" [disabled]="!canMove(1)" (click)="move(1)">
        <app-icon class="icon" name="arrow_downward" />
      </button>
      <span class="toolbar-sep"></span>
      <button class="icon-button" title="Formula Editor" [disabled]="!canEditFormula()" (click)="openSelectedFormula()">
        <app-icon class="icon" name="function" />
      </button>
      <span class="secondary small">[Name] another property, [..] the parent, js: JavaScript</span>
    </div>

    @if (blocked()) {
      <div class="script-banner">
        <app-icon class="icon small" name="warning" />
        <span>Some JavaScript formulas were written on another computer and don't run until you allow them.</span>
        <button type="button" (click)="allowScripts()">Allow</button>
      </div>
    }

    <div class="props-scroll" [class.fill]="fill()">
      <table class="props-table">
        <thead>
          <tr><th>Name</th><th>Formula</th><th class="units-col">Input Units</th><th class="num">{{ resultTitle() }}</th><th class="units-col">Output Units</th></tr>
        </thead>
        <tbody>
          @for (group of groups(); track group.name) {
            <tr class="props-group" (click)="toggleGroup(group.name)">
              <td colspan="5">
                <app-icon class="icon small" [name]="closedGroups().has(group.name) ? 'chevron_right' : 'expand_more'" />
                {{ group.name }}
              </td>
            </tr>
            @if (!closedGroups().has(group.name)) {
              @for (row of group.rows; track row.index) {
                <tr [class.selected]="selected() === row.index" (click)="selected.set(row.index)" (dblclick)="edit(row.index)">
                  <!-- Drag a name onto a formula to insert [Name] -->
                  <td class="indent prop-name" draggable="true" title="Drag onto a formula to use this property"
                      (dragstart)="dragProperty(row.prop, $event)">{{ row.prop.name }}</td>
                  <td>
                    @if (row.prop.takeoff) {
                      <span class="secondary small">Measured on the plan</span>
                    } @else {
                      <div class="formula-cell">
                        <input class="formula" [class.script]="row.script" [value]="row.prop.formula"
                               (dblclick)="$event.stopPropagation(); openFormula(row.index)"
                               (dragover)="$event.preventDefault()" (drop)="dropOnFormula(row.index, $event)"
                               (input)="setFormula(row.index, $event, false)" (change)="setFormula(row.index, $event, true)" />
                        <button type="button" class="dots-button" title="Formula Editor"
                                (click)="$event.stopPropagation(); openFormula(row.index)">…</button>
                      </div>
                    }
                  </td>
                  <td><input class="units-input" [attr.list]="unitsListId" [value]="row.prop.inputUnits" placeholder="—"
                             (change)="patchRow(row.index, { inputUnits: text($event).trim() })" /></td>
                  <td class="num result" [class.error]="!!row.error" [title]="row.title">{{ row.result }}</td>
                  <td><input class="units-input" [attr.list]="unitsListId" [value]="row.prop.units" placeholder="—"
                             (change)="patchRow(row.index, { units: text($event).trim() })" /></td>
                </tr>
              }
            }
          }
        </tbody>
      </table>
    </div>

    <!-- Every unit of measure; any other text can be typed too -->
    <datalist [id]="unitsListId">
      @for (u of units; track u.value) { <option [value]="u.value">{{ u.label }}</option> }
    </datalist>

    <!-- Formula Editor: simple formula or JavaScript, operators, properties (click or drag), live result -->
    @if (formulaEditor(); as f) {
      <div class="dialog-backdrop" (click)="$event.stopPropagation()">
        <div class="dialog formula-dialog">
          <h2>Formula Editor: {{ props()[f.index].name }}</h2>
          <div class="formula-tabs">
            <button type="button" [class.active]="!f.script" (click)="setScriptMode(false)">Formula</button>
            <button type="button" [class.active]="f.script" (click)="setScriptMode(true)">JavaScript</button>
          </div>
          <div class="props-toolbar">
            @for (op of (f.script ? scriptOperators : operators); track op) {
              <button type="button" class="op-button" (mousedown)="$event.preventDefault()" (click)="insert(op)">{{ op.trim() }}</button>
            }
            <button type="button" class="op-button" title="Same property of the parent"
                    (mousedown)="$event.preventDefault()" (click)="insert('[..]')">[..]</button>
            @if (f.script) {
              @for (h of scriptHelpers; track h.text) {
                <button type="button" class="op-button" [title]="h.title" (mousedown)="$event.preventDefault()"
                        (click)="insert(h.text)">{{ h.label }}</button>
              }
            }
          </div>
          <div class="formula-body">
            <textarea #formulaBox class="formula-text" [value]="f.text" spellcheck="false"
                      (input)="setEditorText($event)" (dragover)="$event.preventDefault()"
                      (drop)="dropInEditor($event)"></textarea>
            <div class="formula-props">
              <div class="secondary small">Properties (click or drag)</div>
              @for (p of props(); track $index) {
                @if ($index !== f.index) {
                  <div class="formula-prop" draggable="true" (dragstart)="dragProperty(p, $event)"
                       (mousedown)="$event.preventDefault()" (click)="insert('[' + p.name + ']')">{{ p.name }}</div>
                }
              }
            </div>
          </div>
          @if (f.script) {
            <p class="secondary small formula-help">
              One expression ([Qty] &gt; 100 ? [Cost Each] * 0.9 : [Cost Each]) or statements with return
              (let waste = 1.1; return Math.ceil([Area] * waste / 32);). Use v("Name"), parent("Name"), parts("Name"),
              round(x, 2) and Math. Square brackets are always property names.
            </p>
          }
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

    <!-- Edit Property: a new row (Add Row) or the one double-clicked -->
    @if (editor(); as e) {
      <div class="dialog-backdrop" (click)="$event.stopPropagation()">
        <form class="dialog" (submit)="$event.preventDefault(); saveEditor()">
          <h2>{{ e.index === null ? 'New Property' : 'Edit Property' }}</h2>
          <label class="field">Name
            <input [value]="e.prop.name" [disabled]="isFixed(e.prop)" (input)="patch({ name: text($event) })" autofocus />
          </label>
          <div class="field-row">
            <label class="field">Type
              <select (change)="patch({ type: $any(text($event)) })">
                @for (t of types; track t) { <option [value]="t" [selected]="e.prop.type === t">{{ t === 'number' ? 'Number' : 'Text' }}</option> }
              </select>
            </label>
            <label class="field">Group
              <input [attr.list]="groupsListId" [value]="e.prop.group" (input)="patch({ group: text($event) })" />
            </label>
          </div>
          <datalist [id]="groupsListId">
            @for (g of groupNames(); track g) { <option [value]="g"></option> }
          </datalist>
          <label class="field">Formula
            <input [value]="e.prop.formula" [disabled]="!!e.prop.takeoff" (input)="patch({ formula: text($event) })" />
          </label>
          <div class="field-row">
            <label class="field">Input Units
              <input [attr.list]="unitsListId" [value]="e.prop.inputUnits" (input)="patch({ inputUnits: text($event) })" />
            </label>
            <label class="field">Output Units
              <input [attr.list]="unitsListId" [value]="e.prop.units" (input)="patch({ units: text($event) })" />
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
export class PropsGrid {
  private readonly store = inject(DrawingStore);
  readonly props = input.required<PropertyDef[]>();
  // What the formulas are calculated from, for a given list of properties
  readonly evalNode = input.required<(props: PropertyDef[]) => EvalNode>();
  readonly resultTitle = input('Result');
  readonly fill = input(false);                                // grow with the page instead of a fixed height
  readonly propsChange = output<PropertyDef[]>();

  readonly types: PropType[] = ['number', 'text'];
  readonly units = unitOptions();
  private readonly id = nextGridId++;
  readonly unitsListId = `props-units-${this.id}`;
  readonly groupsListId = `props-groups-${this.id}`;
  readonly operators = [' + ', ' - ', ' * ', ' / ', '(', ')'];
  readonly scriptOperators = [' + ', ' - ', ' * ', ' / ', '(', ')', ' > ', ' < ', ' >= ', ' <= ', ' === ', ' && ', ' || ', ' ? ', ' : '];
  readonly scriptHelpers = [
    { label: 'return', text: 'return ', title: 'Statements: end with return value;' },
    { label: 'round', text: 'round(, 2)', title: 'round(x, decimals)' },
    { label: 'Math.ceil', text: 'Math.ceil()', title: 'Round up' },
    { label: 'Math.max', text: 'Math.max(, )', title: 'Larger of the values' },
    { label: 'parts', text: 'parts("")', title: 'Sum of a property of the parts below' },
    { label: 'parent', text: 'parent("")', title: 'A property of the item above' },
  ];

  readonly selected = signal<number | null>(null);           // index in props
  readonly closedGroups = signal(new Set<string>());
  readonly editor = signal<{ index: number | null; prop: PropertyDef } | null>(null);
  readonly formulaEditor = signal<{ index: number; text: string; script: boolean } | null>(null);
  readonly formulaBox = viewChild<ElementRef<HTMLTextAreaElement>>('formulaBox');
  private readonly trustVersion = signal(0);                  // results change when scripts are allowed

  readonly groupNames = computed(() => {
    const names = [...PROPERTY_GROUPS];
    for (const p of this.props()) if (p.group && !names.includes(p.group)) names.push(p.group);
    return names;
  });

  // Rows with their results; a result is converted from the input units to the output units
  readonly rows = computed(() => {
    this.store.watch();
    this.trustVersion();
    const props = this.props();
    const node = this.evalNode()(props);
    return props.map((prop, index) => {
      const r = evaluate(node, prop.name);
      const result = formatResult(r, prop.decimals);
      const converts = typeof r.value === 'number' && !!prop.inputUnits && !!prop.units && prop.inputUnits !== prop.units
        && convertUnits(1, prop.inputUnits, prop.units) !== null;
      const mismatch = typeof r.value === 'number' && !!findUnit(prop.inputUnits) && !!findUnit(prop.units)
        && convertUnits(1, prop.inputUnits, prop.units) === null;
      const title = r.error ?? (converts ? `Calculated in ${prop.inputUnits}, shown in ${prop.units}`
        : mismatch ? `${prop.inputUnits} can't be converted to ${prop.units}` : '');
      return { index, prop, result, error: r.error, title, script: isScriptFormula(prop.formula) };
    });
  });

  readonly groups = computed(() => {
    const rows = this.rows();
    return this.groupNames()
      .map(name => ({ name, rows: rows.filter(r => (r.prop.group || 'Item') === name) }))
      .filter(g => g.rows.length > 0);
  });

  // JavaScript formulas that came with the document (or an imported library) and weren't allowed yet
  readonly blocked = computed(() => {
    this.trustVersion();
    return this.props().some(p => isScriptFormula(p.formula) && !isScriptTrusted(scriptCode(p.formula)));
  });

  isFixed(p: PropertyDef): boolean {
    return p.name === 'Name' || p.name === 'Type';
  }

  // Name and Type are fixed; measured values come from the plan
  readonly canDelete = computed(() => {
    const i = this.selected();
    const p = i === null ? null : this.props()[i];
    return !!p && !p.takeoff && !this.isFixed(p);
  });

  readonly canEditFormula = computed(() => {
    const i = this.selected();
    return i !== null && !!this.props()[i] && !this.props()[i].takeoff;
  });

  readonly editorError = computed(() => {
    const e = this.editor();
    if (!e) return '';
    const name = e.prop.name.trim();
    if (!name) return 'The property needs a name';
    if (/[[\]]/.test(name)) return 'The name can\'t have [ or ]';
    const taken = this.props().some((p, i) => i !== e.index && p.name.trim().toLowerCase() === name.toLowerCase());
    return taken ? `There is already a property "${name}"` : '';
  });

  text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  clampDecimals(value: string): number {
    return Math.max(0, Math.min(8, Math.round(Number(value) || 0)));
  }

  private emit(list: PropertyDef[]): void {
    this.propsChange.emit(list);
  }

  patchRow(index: number, change: Partial<PropertyDef>): void {
    this.emit(this.props().map((p, i) => i === index ? { ...p, ...change } : p));
  }

  toggleGroup(name: string): void {
    this.closedGroups.update(set => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // Formulas typed here are the user's own: JavaScript ones may run (saved when the field is left)
  setFormula(index: number, event: Event, done: boolean): void {
    const formula = this.text(event);
    if (isScriptFormula(formula)) trustScripts([scriptCode(formula)], done);
    this.patchRow(index, { formula });
  }

  allowScripts(): void {
    trustScripts(scriptsOf(this.props()));
    this.trustVersion.update(v => v + 1);
    this.store.touch();
  }

  // MARK: - Rows
  newProperty(): void {
    const i = this.selected();
    const group = i !== null ? this.props()[i]?.group || 'Item' : 'Item';
    let name = 'New Property';
    for (let n = 2; this.props().some(p => p.name.toLowerCase() === name.toLowerCase()); n++) name = `New Property ${n}`;
    this.editor.set({ index: null, prop: { name, group, type: 'number', formula: '', inputUnits: '', units: '', decimals: 2 } });
  }

  edit(index: number): void {
    this.selected.set(index);
    this.editor.set({ index, prop: { ...this.props()[index] } });
  }

  editSelected(): void {
    const i = this.selected();
    if (i !== null) this.edit(i);
  }

  patch(change: Partial<PropertyDef>): void {
    this.editor.update(e => e && { ...e, prop: { ...e.prop, ...change } });
  }

  // Ok in Edit Property: a new row goes after the selected one (same group) or at the end of its group
  saveEditor(): void {
    const e = this.editor();
    if (!e || this.editorError()) return;
    const prop: PropertyDef = { ...e.prop, name: e.prop.name.trim(), group: e.prop.group.trim() || 'Item',
      inputUnits: e.prop.inputUnits.trim(), units: e.prop.units.trim() };
    if (isScriptFormula(prop.formula)) trustScripts([scriptCode(prop.formula)]);
    const list = [...this.props()];
    if (e.index !== null) {
      list[e.index] = prop;
      this.selected.set(e.index);
    } else {
      const sel = this.selected();
      let at = sel !== null && list[sel]?.group === prop.group ? sel : -1;
      if (at < 0) list.forEach((p, i) => { if (p.group === prop.group) at = i; });
      at = at < 0 ? list.length : at + 1;
      list.splice(at, 0, prop);
      this.selected.set(at);
      this.closedGroups.update(set => { const next = new Set(set); next.delete(prop.group); return next; });
    }
    this.emit(list);
    this.editor.set(null);
  }

  deleteSelected(): void {
    const i = this.selected();
    if (i === null || !this.canDelete()) return;
    this.emit(this.props().filter((_, n) => n !== i));
    this.selected.set(null);
  }

  // The row before / after the selected one in the same group
  private neighbor(direction: -1 | 1): number {
    const i = this.selected();
    const list = this.props();
    if (i === null || !list[i]) return -1;
    const group = list[i].group || 'Item';
    for (let j = i + direction; j >= 0 && j < list.length; j += direction) {
      if ((list[j].group || 'Item') === group) return j;
    }
    return -1;
  }

  canMove(direction: -1 | 1): boolean {
    return this.neighbor(direction) >= 0;
  }

  move(direction: -1 | 1): void {
    const i = this.selected();
    const j = this.neighbor(direction);
    if (i === null || j < 0) return;
    const list = [...this.props()];
    [list[i], list[j]] = [list[j], list[i]];
    this.selected.set(j);
    this.emit(list);
  }

  // MARK: - Formula Editor
  openFormula(index: number): void {
    const p = this.props()[index];
    if (!p || p.takeoff) return;
    this.selected.set(index);
    const script = isScriptFormula(p.formula);
    this.formulaEditor.set({ index, text: script ? scriptCode(p.formula) : p.formula, script });
    setTimeout(() => this.formulaBox()?.nativeElement.focus(), 0);
  }

  openSelectedFormula(): void {
    const i = this.selected();
    if (i !== null) this.openFormula(i);
  }

  // A simple formula is valid JavaScript too, so switching keeps the text
  setScriptMode(script: boolean): void {
    this.formulaEditor.update(f => f && { ...f, script });
    setTimeout(() => this.formulaBox()?.nativeElement.focus(), 0);
  }

  private editorFormula(f: { text: string; script: boolean }): string {
    return f.script ? toScriptFormula(f.text) : f.text.trim();
  }

  // Result of the formula being edited, with the other properties as they are in the grid
  readonly editorResult = computed(() => {
    const f = this.formulaEditor();
    if (!f) return { text: '', error: undefined as string | undefined };
    this.store.watch();
    const formula = this.editorFormula(f);
    if (f.script) trustScripts([f.text], false);
    const props = this.props().map((p, i) => i === f.index ? { ...p, formula } : p);
    const r = evaluate(this.evalNode()(props), props[f.index].name);
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
    // Inside the parentheses or quotes of a helper
    const inside = /\(|"/.test(piece) ? piece.search(/\(\)|""|\(,/) : -1;
    const caret = start + (inside >= 0 ? inside + 1 : piece.length);
    box.setSelectionRange(caret, caret);
    box.focus();
  }

  saveFormula(): void {
    const f = this.formulaEditor();
    if (!f) return;
    if (f.script) trustScripts([f.text]);
    this.patchRow(f.index, { formula: this.editorFormula(f) });
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
    const formula = this.props()[index].formula + piece;
    if (isScriptFormula(formula)) trustScripts([scriptCode(formula)]);
    this.patchRow(index, { formula });
  }

  dropInEditor(event: DragEvent): void {
    const piece = event.dataTransfer?.getData('text/plain');
    if (!piece) return;
    event.preventDefault();
    this.insert(piece);
  }

  // Escape closes the inner dialogs first; returns true when one was open
  closeInner(): boolean {
    if (this.formulaEditor()) { this.formulaEditor.set(null); return true; }
    if (this.editor()) { this.editor.set(null); return true; }
    return false;
  }

  escape(event: Event): void {
    if (this.closeInner()) event.stopPropagation();
  }
}
