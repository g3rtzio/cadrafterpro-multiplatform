import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TakeoffKind, kindIcon, kindTitle } from '../../models/takeoff';
import { PART_DRAG_TYPE, TakeoffTemplate } from '../../models/templates';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { CostDatabase, TemplateLibrary } from '../../services/template-library/template-library';
import { Icon } from '../icon/icon';

// One line of the panel: a folder or a template, indented by its depth
interface Row {
  key: string;
  depth: number;
  folderId?: string;
  name: string;
  template?: TakeoffTemplate;
  path?: string;                     // folder path, shown while searching
}

// Templates panel of the right side bar (like PlanSwift's "Templates, Inputs"):
// the template library, ready to use in the open document. Click a template to measure with it
// (its properties and parts are copied into the estimate); the Templates tab is where they are edited.
// Part templates (and every part of the Cost Database, [database]="true") are clicked to add them under
// the selected item, or dragged onto an element or part of the estimate.
@Component({
  selector: 'app-templates-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties' },
  template: `
    @let s = store.watch();
    <section class="panel-section">
      <div class="search-box">
        <app-icon class="icon small secondary" name="search" />
        <input type="text" [placeholder]="database() ? 'Find part' : 'Find template'" [value]="filter()" (input)="filter.set(value($event))" />
        @if (filter()) {
          <button class="icon-button" title="Clear" (click)="filter.set('')"><app-icon class="icon small" name="close" /></button>
        }
      </div>
      @if (!s.hasDocument) { <div class="secondary small">Open a drawing to use a template.</div> }

      <div class="template-list">
        @for (row of rows(); track row.key) {
          @if (row.template; as t) {
            <button class="template-row" [style.padding-left.px]="8 + row.depth * 14" [disabled]="!s.hasDocument && !t.isPart"
                    [attr.draggable]="t.isPart ? 'true' : null" (dragstart)="dragPart(t, $event)"
                    [title]="t.isPart ? 'Add part ' + t.name + ' to the selected item' : 'Measure with ' + t.name + ' (' + title(t.kind) + ')'"
                    (click)="lib.useTemplate(t.id)">
              <app-icon class="icon small" [style.color]="t.color" [name]="t.isPart ? (database() ? 'database' : 'widgets') : icon(t.kind)" />
              <span class="template-name">
                {{ t.name }}
                @if (row.path) { <span class="secondary small"> · {{ row.path }}</span> }
              </span>
              @if (inDocument(t)) { <span class="badge" title="Already in this document">In use</span> }
              <app-icon class="icon small accent play" name="play_arrow" />
            </button>
          } @else {
            <button class="folder-row" [style.padding-left.px]="4 + row.depth * 14" (click)="toggle(row.folderId!)">
              <app-icon class="icon small" [name]="isOpen(row.folderId!) ? 'expand_more' : 'chevron_right'" />
              <app-icon class="icon small folder" name="folder" />
              <span class="template-name">{{ row.name }}</span>
            </button>
          }
        } @empty {
          <div class="secondary small">
            @if (database()) { {{ filter() ? 'No parts match.' : 'No parts yet. Make them in the Cost Database tab.' }} }
            @else { {{ filter() ? 'No templates match.' : 'No templates yet. Make them in the Templates tab.' }} }
          </div>
        }
      </div>
      <div class="row-buttons">
        @if (database()) {
          <button (click)="s.showTab('Cost Database')"><app-icon class="icon small" name="edit" /> Edit Cost Database…</button>
          <button [disabled]="!s.hasDocument" title="Copy these prices to every part of the document with the same name"
                  (click)="lib.updateDocumentPrices()"><app-icon class="icon small" name="price_change" /> Update Prices</button>
        } @else {
          <button (click)="s.showTab('Templates')"><app-icon class="icon small" name="edit" /> Edit Templates…</button>
        }
      </div>
      @if (database()) {
        <p class="secondary small">Drag a part onto an element or part of the estimate to add it there, or click it to add it
          to the item selected on the plan or in the estimate.</p>
      } @else {
        <p class="secondary small">Click a template to measure with it on the plan. Its properties and parts go into the estimate.
          Part templates (<app-icon class="icon small" name="widgets" />) are added as parts of the item selected on the plan or in
          the estimate, or dragged onto an element of the estimate.</p>
      }
    </section>
  `,
  styles: [`
    .search-box { display: flex; align-items: center; gap: 4px; padding: 0 2px 0 6px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 6px; }
    .search-box input { flex: 1; min-width: 0; border: none; background: transparent; padding: 4px 0; outline: none; }
    .template-list { display: flex; flex-direction: column; }
    .template-row, .folder-row { display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: transparent;
      text-align: left; padding-top: 3px; padding-bottom: 3px; padding-right: 4px; border-radius: 5px; }
    .template-row:hover:not(:disabled), .folder-row:hover { background: var(--hover); }
    .folder-row { font-weight: 600; }
    .folder { color: #e3a008; }
    .template-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .play { opacity: 0; }
    .template-row:hover:not(:disabled) .play { opacity: 1; }
    .badge { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); flex: none; }
  `],
})
export class TemplatesPanel {
  readonly store = inject(DrawingStore);
  readonly database = input(false);                 // true = the Cost Database (parts only)
  private readonly templates = inject(TemplateLibrary);
  private readonly costDatabase = inject(CostDatabase);
  get lib(): TemplateLibrary { return this.database() ? this.costDatabase : this.templates; }
  readonly filter = signal('');
  // Folders closed in this panel (separate from the Templates tab)
  private readonly closed = signal<ReadonlySet<string>>(new Set());

  readonly rows = computed<Row[]>(() => {
    const l = this.lib.watch();
    const q = this.filter().trim().toLowerCase();
    const rows: Row[] = [];
    if (q) {
      // Searching: every matching template, with the folder it is in
      for (const t of l.data.templates) {
        if (!t.name.toLowerCase().includes(q)) continue;
        rows.push({ key: t.id, depth: 0, name: t.name, template: t, path: this.folderPath(t.folderId) });
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    const closed = this.closed();
    const walk = (folderId: string | null, depth: number) => {
      for (const f of l.subFolders(folderId)) {
        rows.push({ key: f.id, depth, folderId: f.id, name: f.name });
        if (!closed.has(f.id)) walk(f.id, depth + 1);
      }
      for (const t of l.templatesIn(folderId)) rows.push({ key: t.id, depth, name: t.name, template: t });
    };
    walk(null, 0);
    return rows;
  });

  isOpen(folderId: string): boolean { return !this.closed().has(folderId); }

  toggle(folderId: string): void {
    const next = new Set(this.closed());
    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
    this.closed.set(next);
  }

  inDocument(t: TakeoffTemplate): boolean {
    if (t.isPart) return this.store.estimate.parts.some(p => this.store.partName(p) === t.name);
    return this.store.items.some(i => i.name === t.name && i.kind === t.kind);
  }

  private folderPath(folderId: string | null): string {
    const names: string[] = [];
    let f = this.lib.folder(folderId);
    for (let guard = 0; f && guard < 20; guard++) {
      names.unshift(f.name);
      f = this.lib.folder(f.parentId);
    }
    return names.join(' › ');
  }

  // A part dragged onto the estimate (see estimate-view): which library and which part
  dragPart(t: TakeoffTemplate, event: DragEvent): void {
    if (!t.isPart || !event.dataTransfer) return;
    event.dataTransfer.setData(PART_DRAG_TYPE, JSON.stringify({ database: this.database(), id: t.id }));
    event.dataTransfer.effectAllowed = 'copy';
  }

  icon(kind: TakeoffKind): string { return kindIcon(kind); }
  title(kind: TakeoffKind): string { return kindTitle(kind); }
  value(e: Event): string { return (e.target as HTMLInputElement).value; }
}
