import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { EvalNode, PropertyDef } from '../../models/estimate';
import { TAKEOFF_KINDS, TakeoffKind, kindIcon, kindTitle } from '../../models/takeoff';
import { PART_DRAG_TYPE, TakeoffTemplate, TemplatePart } from '../../models/templates';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { CostDatabase, TemplateLibrary } from '../../services/template-library/template-library';
import { AutoFocus } from '../auto-focus/auto-focus';
import { PropsGrid } from '../props-grid/props-grid';
import { Resizable } from '../resizable/resizable';
import { Icon } from '../icon/icon';

// "Templates" tab (PlanSwift style): the template library on the left (folders, templates and
// their parts) and the selected template or part on the right, with its properties.
// Double-click a template (or press Use Template) to measure with it on the plan; a part template
// is added under the item selected in the estimate or on the plan.
// Drag templates and folders onto a folder to move them, or onto the empty area for the top level.
// Parts dragged from the side bar (part templates or Cost Database parts) onto a template or one of its
// parts are copied into it as a child part.
// The "Cost Database" tab is this same view with [database]="true": a library of priced parts only.
@Component({
  selector: 'app-templates-view',
  imports: [Icon, AutoFocus, NgTemplateOutlet, PropsGrid, Resizable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'templates-view',
    tabindex: '0',
    '(keydown.delete)': 'deleteKey($event)',
    '(keydown.backspace)': 'deleteKey($event)',
  },
  template: `
    @let lib = library.watch();
    <!-- Left: the library tree -->
    <div class="templates-tree-pane" appResizable="right" resizeKey="templatesTree" [minWidth]="180" [maxWidth]="700">
    <section class="templates-tree" (click)="lib.select(null)"
             (dragover)="allowDrop($event, null)" (drop)="drop($event, null)">
      <div class="templates-heading">{{ lib.title }}</div>
      <ng-container *ngTemplateOutlet="folderLevel; context: { $implicit: null, depth: 0 }" />
      @if (lib.data.folders.length === 0 && lib.data.templates.length === 0) {
        <div class="secondary small templates-empty">
          {{ lib.partsOnly ? 'No parts yet. Use New Part.' : 'No templates yet. Use New Template, or Add from Document.' }}
        </div>
      }
    </section>
    </div>

    <!-- Right: the selected template or part -->
    <section class="templates-detail">
      @let t = lib.selectedTemplate;
      @let part = lib.selectedPart;
      @if (t) {
        <div class="templates-detail-header">
          <app-icon class="icon" [style.color]="t.color" [name]="t.isPart ? 'widgets' : icon(t.kind)" />
          <h2>{{ part ? lib.partName(part) : t.name }}</h2>
          @if (part) { <span class="secondary">Part of {{ t.name }}</span> }
          @if (t.isPart && !part) { <span class="secondary">{{ lib.partsOnly ? 'Part' : 'Part template' }}</span> }
          <span class="spacer"></span>
          @if (part && !lib.partsOnly) {
            <button title="Save this part (and the parts below it) as its own part template" (click)="lib.savePartAsTemplate()">
              <app-icon class="icon small" name="widgets" /> Save as Part Template
            </button>
          }
          @if (t.isPart) {
            <button class="primary" [disabled]="!store.watch().hasDocument"
                    title="Add this part under the item selected in the estimate or on the plan" (click)="lib.useTemplate(t.id)">
              <app-icon class="icon small" name="add_box" /> Add to Selected Item
            </button>
          } @else {
            <button class="primary" [disabled]="!store.watch().hasDocument" title="Measure with this template on the plan"
                    (click)="lib.useTemplate(t.id)">
              <app-icon class="icon small" name="play_arrow" /> Use Template
            </button>
          }
        </div>
        @if (!part) {
          <div class="templates-fields">
            <label>Name <input [value]="t.name" (change)="lib.updateTemplate(t.id, { name: value($event) })" /></label>
            @if (!t.isPart) {
            <label>Type
              <select (change)="lib.updateTemplate(t.id, { kind: $any(value($event)) })">
                @for (k of kinds; track k) { <option [value]="k" [selected]="t.kind === k">{{ title(k) }}</option> }
              </select>
            </label>
            <label>Color <input type="color" [value]="t.color" (change)="lib.updateTemplate(t.id, { color: value($event) })" /></label>
            }
            <span class="secondary small">{{ t.parts.length }} {{ t.parts.length === 1 ? (t.isPart ? 'sub-part' : 'part') : (t.isPart ? 'sub-parts' : 'parts') }}</span>
          </div>
        }
        @let owner = part ?? t;
        <app-props-grid class="templates-props" [props]="owner.props" [evalNode]="exampleNode" resultTitle="Example Result"
                        [fill]="true" (propsChange)="lib.setProps(owner, $event)" />
        <p class="secondary small">
          Formulas work like in the estimate: [Qty] * [Cost Each], or JavaScript after js:. Parts use [..] to take the value
          of the item above them. The example result is calculated without measurements (they count as 0) and converted
          from the input units to the output units.
        </p>
      } @else {
        <div class="estimate-empty">
          <app-icon class="icon big" name="inventory_2" />
          @if (lib.partsOnly) {
            <div class="estimate-empty-title">No Part Selected</div>
            <div class="secondary">Select a part to see its prices. Drag it from the side bar onto an element of the estimate,
              or use Update Prices to copy these prices to the parts of the document with the same name.</div>
          } @else {
            <div class="estimate-empty-title">No Template Selected</div>
            <div class="secondary">Select a template to see its properties, or double-click it to measure with it. Part templates are added under the selected item of the estimate.</div>
          }
        </div>
      }
    </section>

    <!-- One level of the tree: folders (with what is inside) then templates -->
    <ng-template #folderLevel let-parentId let-depth="depth">
      @for (f of lib.subFolders(parentId); track f.id) {
        <div class="tree-row" [class.selected]="isSelected('folder', f.id)" [style.padding-left.px]="4 + depth * 16"
             draggable="true" (dragstart)="dragStart($event, 'folder', f.id)"
             (dragover)="allowDrop($event, f.id)" (drop)="drop($event, f.id)" [class.drop-target]="dropTarget() === f.id"
             (click)="lib.select({ type: 'folder', id: f.id }); $event.stopPropagation()"
             (dblclick)="lib.renaming = f.id; lib.select({ type: 'folder', id: f.id })">
          <button class="disclosure" (click)="lib.toggle(f.id); $event.stopPropagation()">
            <app-icon class="icon small" [name]="lib.collapsed.has(f.id) ? 'chevron_right' : 'expand_more'" />
          </button>
          <app-icon class="icon small" style="color: #ffcc00" name="folder" />
          @if (lib.renaming === f.id) {
            <input class="rename" [value]="f.name" appAutoFocus (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()"
                   (keydown.enter)="renameFolder(f.id, $event)" (keydown.escape)="lib.renameFolder(f.id, f.name)"
                   (keydown.delete)="$event.stopPropagation()" (keydown.backspace)="$event.stopPropagation()"
                   (blur)="renameFolder(f.id, $event)" />
          } @else {
            <span class="name">{{ f.name }}</span>
          }
        </div>
        @if (!lib.collapsed.has(f.id)) {
          <ng-container *ngTemplateOutlet="folderLevel; context: { $implicit: f.id, depth: depth + 1 }" />
        }
      }
      @for (t of lib.templatesIn(parentId); track t.id) {
        <div class="tree-row" [class.selected]="isSelected('template', t.id)" [style.padding-left.px]="4 + depth * 16"
             draggable="true" (dragstart)="dragStart($event, 'template', t.id)"
             (dragover)="partOver($event, t.id)" (dragleave)="dropTarget.set(undefined)" (drop)="partDrop($event, t, null)"
             [class.drop-target]="dropTarget() === t.id"
             (click)="lib.select({ type: 'template', id: t.id }); $event.stopPropagation()"
             (dblclick)="lib.useTemplate(t.id)"
             [title]="t.isPart ? 'Part template: double-click to add it to the selected item of the estimate' : 'Double-click to measure with it'">
          <button class="disclosure" [style.visibility]="t.parts.length ? 'visible' : 'hidden'"
                  (click)="lib.toggle(t.id); $event.stopPropagation()">
            <app-icon class="icon small" [name]="lib.collapsed.has(t.id) ? 'chevron_right' : 'expand_more'" />
          </button>
          <app-icon class="icon small" [style.color]="t.color" [name]="t.isPart ? 'widgets' : icon(t.kind)" />
          <span class="name">{{ t.name }}</span>
        </div>
        @if (!lib.collapsed.has(t.id)) {
          <ng-container *ngTemplateOutlet="partLevel; context: { $implicit: t, parentId: null, depth: depth + 1 }" />
        }
      }
    </ng-template>

    <!-- Parts of a template, nested under their parent part -->
    <ng-template #partLevel let-t let-parentId="parentId" let-depth="depth">
      @for (p of parts(t, parentId); track p.id) {
        <div class="tree-row" [class.selected]="isSelected('part', p.id)" [style.padding-left.px]="4 + depth * 16"
             (dragover)="partOver($event, p.id)" (dragleave)="dropTarget.set(undefined)" (drop)="partDrop($event, t, p.id)"
             [class.drop-target]="dropTarget() === p.id"
             (click)="lib.select({ type: 'part', templateId: t.id, id: p.id }); $event.stopPropagation()">
          <button class="disclosure" [style.visibility]="parts(t, p.id).length ? 'visible' : 'hidden'"
                  (click)="lib.toggle(p.id); $event.stopPropagation()">
            <app-icon class="icon small" [name]="lib.collapsed.has(p.id) ? 'chevron_right' : 'expand_more'" />
          </button>
          <app-icon class="icon small" style="color: #ff9500" name="widgets" />
          <span class="name">{{ lib.partName(p) }}</span>
        </div>
        @if (!lib.collapsed.has(p.id)) {
          <ng-container *ngTemplateOutlet="partLevel; context: { $implicit: t, parentId: p.id, depth: depth + 1 }" />
        }
      }
    </ng-template>
  `,
})
export class TemplatesView {
  readonly store = inject(DrawingStore);
  readonly database = input(false);                 // true = Cost Database tab
  private readonly templates = inject(TemplateLibrary);
  private readonly costDatabase = inject(CostDatabase);
  get library(): TemplateLibrary { return this.database() ? this.costDatabase : this.templates; }
  readonly kinds = TAKEOFF_KINDS;
  readonly dropTarget = signal<string | null | undefined>(undefined);   // undefined = not dragging
  private readonly lib = computed(() => this.library.watch());

  icon(kind: TakeoffKind): string { return kindIcon(kind); }
  title(kind: TakeoffKind): string { return kindTitle(kind); }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  isSelected(type: 'folder' | 'template' | 'part', id: string): boolean {
    const s = this.lib().selection;
    return !!s && s.type === type && s.id === id;
  }

  parts(t: TakeoffTemplate, parentId: string | null): TemplatePart[] {
    return this.library.partsOf(t, parentId);
  }

  // What the example results are calculated from: no measurements (0), parts read the items above
  // them through [..] and the parts below through [Parts:…]. `props` is the list shown in the grid.
  readonly exampleNode = (props: PropertyDef[]): EvalNode => {
    const t = this.library.selectedTemplate;
    const owner: { props: PropertyDef[] } | undefined = this.library.selectedPart ?? t;
    const zero = { 'Area': 0, 'Linear Total': 0, 'Segment Count': 0, 'Point Count': 0, 'Section Count': 0 };
    const propsOf = (o: { props: PropertyDef[] }) => o === owner ? props : o.props;
    const children = (o: { props: PropertyDef[] }, depth: number) => () => !t || depth > 20 ? [] :
      t.parts.filter(x => x.parentId === (o === t ? null : (o as TemplatePart).id)).map(x => node(x, depth + 1));
    const node = (o: { props: PropertyDef[] }, depth = 0): EvalNode => {
      if (!t || o === t || depth > 20) return { props: propsOf(o), takeoff: zero, parent: null, children: children(o, depth) };
      const part = o as TemplatePart;
      const parent = part.parentId ? t.parts.find(x => x.id === part.parentId) : t;
      return { props: propsOf(o), takeoff: null, parent: parent ? node(parent, depth + 1) : null, children: children(o, depth) };
    };
    return owner ? node(owner) : { props, takeoff: zero, parent: null };
  };

  renameFolder(id: string, event: Event): void {
    if (this.library.renaming !== id) return;
    this.library.renameFolder(id, (event.target as HTMLInputElement).value);
  }

  deleteKey(event: Event): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    event.preventDefault();
    this.library.deleteSelection();
  }

  // MARK: - Drag and drop
  dragStart(event: DragEvent, kind: 'folder' | 'template', id: string): void {
    event.stopPropagation();
    event.dataTransfer?.setData('application/x-cadrafter-template', JSON.stringify({ kind, id }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  // A part from the side bar over a template or a part of one
  partOver(event: DragEvent, id: string): void {
    if (!event.dataTransfer?.types.includes(PART_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    this.dropTarget.set(id);
  }

  partDrop(event: DragEvent, t: TakeoffTemplate, parentId: string | null): void {
    const text = event.dataTransfer?.getData(PART_DRAG_TYPE);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget.set(undefined);
    const { database, id } = JSON.parse(text) as { database: boolean; id: string };
    const source = (database ? this.costDatabase : this.templates).template(id);
    if (source) this.library.addPartToTemplate(source, t.id, parentId);
  }

  allowDrop(event: DragEvent, folderId: string | null): void {
    if (!event.dataTransfer?.types.includes('application/x-cadrafter-template')) return;
    event.preventDefault();
    event.stopPropagation();
    this.dropTarget.set(folderId);
  }

  drop(event: DragEvent, folderId: string | null): void {
    const text = event.dataTransfer?.getData('application/x-cadrafter-template');
    this.dropTarget.set(undefined);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    const { kind, id } = JSON.parse(text) as { kind: 'folder' | 'template'; id: string };
    this.library.move(kind, id, folderId);
  }
}
