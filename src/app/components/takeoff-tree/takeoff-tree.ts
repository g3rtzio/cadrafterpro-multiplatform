import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Markup, PlanElement } from '../../models/elements';
import { TakeoffItem, kindIcon, kindUnit } from '../../models/takeoff';
import { DrawingStore, MarkupGroup } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// Element tree: pages › takeoff items and groups of PDF markups — port of TakeoffTreeView.swift
// `filter` (the search box above it): pages whose name matches show everything; other pages show
// only the elements whose name matches, already open.
// Click selects an element; Shift + click selects every row from the first one clicked to this one,
// Ctrl / ⌘ + click adds or removes one, Ctrl + Shift + click adds a range to what is selected.
// Up / Down arrows (with the tree focused) go to the previous / next page in the list.
@Component({
  selector: 'app-takeoff-tree',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tree', tabindex: '0', '(keydown)': 'onKey($event)' },
  template: `
    @let s = store.watch();
    @if (!s.hasDocument) {
      <div class="secondary pad">Open a drawing</div>
    }
    @for (page of s.pages; track $index; let index = $index) {
      @let allTakeoffs = s.itemsOnPage(index);
      @let pageHit = pageMatches(index);
      @let takeoffs = pageHit ? allTakeoffs : matchingItems(allTakeoffs);
      @let groups = pageHit ? otherGroups(index, allTakeoffs) : matchingGroups(otherGroups(index, allTakeoffs));
      @let isCurrent = index === s.currentPageIndex;
      @if (!searching() || pageHit || takeoffs.length || groups.length) {
      <!-- Page row: double click or right click to rename it. The page shown in the plan is highlighted -->
      <div class="tree-row page-row" [attr.data-page]="index" [class.current]="isCurrent"
           [class.selected]="!isCurrent && s.selectedPages.includes(index)" (click)="s.clickPage(index, $event)"
           (dblclick)="startEdit('page-' + index, s.pageNames.get(index) ?? '')"
           (contextmenu)="$event.preventDefault(); startEdit('page-' + index, s.pageNames.get(index) ?? '')">
        <button class="disclosure" (click)="$event.stopPropagation(); toggle('page-' + index)">
          <app-icon class="icon small" [name]="pageOpen(index, pageHit) ? 'expand_more' : 'chevron_right'" />
        </button>
        <app-icon class="icon small" [name]="isCurrent ? 'description' : 'draft'" />
        @if (editingKey() === 'page-' + index) {
          <input class="rename" [value]="editText()" placeholder="Leave empty for the default name" (click)="$event.stopPropagation()"
                 (input)="editText.set($any($event.target).value)" (keydown.enter)="finishPageRename(index)"
                 (keydown.escape)="editingKey.set(null)" (blur)="finishPageRename(index)" [attr.autofocus]="true" />
        } @else {
          <span class="name">{{ s.pageName(index) }}</span>
        }
        <span class="count">{{ countOf(groups) + takeoffs.length }}</span>
      </div>

      @if (pageOpen(index, pageHit)) {
        <div class="tree-children">
          <!-- App measurements (green dot = keep measuring with that item on the page shown).
               PDF markups with the same name are part of the same element -->
          @for (item of takeoffs; track item.id) {
            @let active = s.selectedItemId === item.id;
            @let saved = s.itemMarkups(item, index);
            @let measured = [...s.measurementsOf(item.id, index), ...saved];
            @let selected = measured.length > 0 && allSelected(measured);
            @let itemKey = 'item-' + index + '-' + item.id;
            <div class="tree-row" [class.active]="active" [class.selected]="!active && selected"
                 (click)="s.goTo(index); pick(itemKey, measured, $event)"
                 (dblclick)="startEdit('item-' + item.id, item.name)"
                 (contextmenu)="$event.preventDefault(); startEdit('item-' + item.id, item.name)">
              @if (saved.length) {
                <button class="disclosure" (click)="$event.stopPropagation(); toggle(itemKey)">
                  <app-icon class="icon small" [name]="isOpen(itemKey) ? 'expand_more' : 'chevron_right'" />
                </button>
              }
              <button class="dot" [class.on]="active" [title]="active ? 'Stop measuring' : 'Continue measuring on this page'"
                      (click)="$event.stopPropagation(); toggleItem(item)"></button>
              <app-icon class="icon small" [style.color]="item.color" [name]="icon(item)" />
              @if (editingKey() === 'item-' + item.id) {
                <input class="rename" [value]="editText()" (click)="$event.stopPropagation()"
                       (input)="editText.set($any($event.target).value)" (keydown.enter)="finishItemRename(item)"
                       (keydown.escape)="editingKey.set(null)" (blur)="finishItemRename(item)" />
              } @else {
                <span class="name" [class.dimmed]="!item.isVisible">{{ item.name }}</span>
              }
              <span class="qty">{{ quantityText(item, index) }} {{ unit(item) }}</span>
              <span class="swatch" [style.background]="item.color"></span>
              <button class="bulb" [class.on]="item.isVisible"
                      (click)="$event.stopPropagation(); s.toggleVisibility(item.id); s.setVisible(saved, item.isVisible)">
                <app-icon class="icon small" name="lightbulb" />
              </button>
              <button class="row-delete" title="Delete" (click)="$event.stopPropagation(); s.selectElements(measured); s.deleteSelected()">
                <app-icon class="icon small" name="delete" />
              </button>
            </div>
            @if (saved.length && isOpen(itemKey)) {
              <div class="tree-children">
                @for (m of saved; track m.id; let i = $index) {
                  <div class="tree-row" [class.selected]="s.isSelected(m)" (click)="pick('m-' + m.id, [m], $event) && s.showElement(m)">
                    <app-icon class="icon small" [style.color]="m.color ?? '#8E8E93'" name="check_box_outline_blank" />
                    <span class="name" [class.dimmed]="!m.visible">{{ m.contents || m.typeName + ' ' + (i + 1) }}</span>
                    <button class="bulb" [class.on]="m.visible" (click)="$event.stopPropagation(); s.setVisible([m], !m.visible)">
                      <app-icon class="icon small" name="lightbulb" />
                    </button>
                  </div>
                }
              </div>
            }
          }
          @if (groups.length === 0 && takeoffs.length === 0) {
            <div class="secondary small pad-left">No annotations</div>
          }

          <!-- Groups of PDF markups (same name) -->
          @for (group of groups; track group.name) {
            @let key = 'group-' + index + '-' + group.name;
            @let active = s.isContinuing(group.markups);
            <div class="tree-row" [class.active]="active" [class.selected]="!active && allSelected(group.markups)"
                 (click)="pick(key, group.markups, $event) && showFirst(group)"
                 (dblclick)="startEdit(key, group.name)"
                 (contextmenu)="$event.preventDefault(); startEdit(key, group.name)">
              <button class="disclosure" (click)="$event.stopPropagation(); toggle(key)">
                <app-icon class="icon small" [name]="isOpen(key) ? 'expand_more' : 'chevron_right'" />
              </button>
              <!-- Green dot: keep adding the same element with every click on the plan -->
              <button class="dot" [class.on]="active" [title]="active ? 'Stop counting' : 'Continue counting'"
                      (click)="$event.stopPropagation(); toggleGroup(group)"></button>
              <span class="small-dot" [style.background]="group.color"></span>
              @if (editingKey() === key) {
                <input class="rename" [value]="editText()" (click)="$event.stopPropagation()"
                       (input)="editText.set($any($event.target).value)" (keydown.enter)="finishGroupRename(group)"
                       (keydown.escape)="editingKey.set(null)" (blur)="finishGroupRename(group)" />
              } @else {
                <span class="name" [class.dimmed]="!group.isVisible">{{ group.name }}</span>
              }
              <span class="qty">{{ group.markups.length }}</span>
              <span class="swatch" [style.background]="group.color"></span>
              <button class="bulb" [class.on]="group.isVisible" (click)="$event.stopPropagation(); s.setVisible(group.markups, !group.isVisible)">
                <app-icon class="icon small" name="lightbulb" />
              </button>
              <button class="row-delete" title="Delete" (click)="$event.stopPropagation(); s.selectElements(group.markups); s.deleteSelected()">
                <app-icon class="icon small" name="delete" />
              </button>
            </div>
            @if (isOpen(key)) {
              <div class="tree-children">
                <!-- A single markup: click selects only that one -->
                @for (m of group.markups; track m.id; let i = $index) {
                  <div class="tree-row" [class.selected]="s.isSelected(m)" (click)="pick('m-' + m.id, [m], $event) && s.showElement(m)">
                    <app-icon class="icon small" [style.color]="m.color ?? '#8E8E93'" name="check_box_outline_blank" />
                    <span class="name" [class.dimmed]="!m.visible">{{ m.contents || m.typeName + ' ' + (i + 1) }}</span>
                    <button class="bulb" [class.on]="m.visible" (click)="$event.stopPropagation(); s.setVisible([m], !m.visible)">
                      <app-icon class="icon small" name="lightbulb" />
                    </button>
                  </div>
                }
              </div>
            }
          }
        </div>
      }
      }
    }
    @if (s.hasDocument && searching() && noMatches()) {
      <div class="secondary small pad">No page or element matches.</div>
    }
  `,
})
export class TakeoffTree {
  readonly store = inject(DrawingStore);
  private readonly open = signal(new Set<string>());
  readonly editingKey = signal<string | null>(null);
  readonly editText = signal('');

  readonly filter = input('');

  // Up / Down: previous / next page among the pages the tree shows (the search box may hide some)
  onKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const s = this.store;
    if (!s.hasDocument) return;
    e.preventDefault();
    const rows = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.page-row[data-page]'));
    const shown = rows.map(r => Number(r.dataset['page']));
    const at = shown.indexOf(s.currentPageIndex);
    const next = at < 0 ? shown[0] : shown[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next === undefined) return;
    s.goTo(next);
    rows[shown.indexOf(next)]?.scrollIntoView({ block: 'nearest' });
  }

  isOpen(key: string): boolean { return this.open().has(key); }

  // MARK: - Selection of several rows
  private anchor: string | null = null;

  // true = a plain click (the caller also shows the element)
  pick(key: string, elements: PlanElement[], e: MouseEvent): boolean {
    const s = this.store;
    const add = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.anchor) {
      const rows = this.visibleRows();
      const i = rows.findIndex(r => r.key === this.anchor), j = rows.findIndex(r => r.key === key);
      if (i >= 0 && j >= 0) {
        const range = rows.slice(Math.min(i, j), Math.max(i, j) + 1).flatMap(r => r.elements);
        s.selectElements([...new Set([...(add ? s.selection : []), ...range])]);
        return false;
      }
    }
    this.anchor = key;
    if (add) {
      const all = elements.length > 0 && elements.every(el => s.selection.includes(el));
      s.selectElements(all ? s.selection.filter(el => !elements.includes(el)) : [...new Set([...s.selection, ...elements])]);
      return false;
    }
    s.selectElements(elements);
    return true;
  }

  // Element rows in the order they are shown (pages open, search applied)
  private visibleRows(): { key: string; elements: PlanElement[] }[] {
    const s = this.store;
    const rows: { key: string; elements: PlanElement[] }[] = [];
    s.pages.forEach((_, index) => {
      const all = s.itemsOnPage(index);
      const pageHit = this.pageMatches(index);
      const takeoffs = pageHit ? all : this.matchingItems(all);
      const groups = pageHit ? this.otherGroups(index, all) : this.matchingGroups(this.otherGroups(index, all));
      if (this.searching() && !pageHit && !takeoffs.length && !groups.length) return;
      if (!this.pageOpen(index, pageHit)) return;
      for (const item of takeoffs) {
        const saved = s.itemMarkups(item, index);
        const itemKey = 'item-' + index + '-' + item.id;
        rows.push({ key: itemKey, elements: [...s.measurementsOf(item.id, index), ...saved] });
        if (saved.length && this.isOpen(itemKey)) saved.forEach(m => rows.push({ key: 'm-' + m.id, elements: [m] }));
      }
      for (const group of groups) {
        const key = 'group-' + index + '-' + group.name;
        rows.push({ key, elements: group.markups });
        if (this.isOpen(key)) group.markups.forEach(m => rows.push({ key: 'm-' + m.id, elements: [m] }));
      }
    });
    return rows;
  }

  // MARK: - Search
  searching(): boolean { return this.filter().trim() !== ''; }

  private hit(name: string): boolean {
    return name.toLowerCase().includes(this.filter().trim().toLowerCase());
  }

  pageMatches(index: number): boolean { return !this.searching() || this.hit(this.store.pageName(index)); }
  matchingItems(items: TakeoffItem[]): TakeoffItem[] { return items.filter(i => this.hit(i.name)); }
  matchingGroups(groups: MarkupGroup[]): MarkupGroup[] { return groups.filter(g => this.hit(g.name)); }

  // While searching, pages shown only for their matching elements are open
  pageOpen(index: number, pageHit: boolean): boolean {
    return this.isOpen('page-' + index) || (this.searching() && !pageHit);
  }

  noMatches(): boolean {
    const s = this.store;
    return s.pages.every((_, i) => !this.hit(s.pageName(i)) &&
      this.matchingItems(s.itemsOnPage(i)).length === 0 &&
      this.matchingGroups(this.otherGroups(i, s.itemsOnPage(i))).length === 0);
  }

  toggle(key: string): void {
    this.open.update(set => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  countOf(groups: MarkupGroup[]): number {
    return groups.reduce((sum, g) => sum + g.markups.length, 0);
  }

  // Markup groups that have no app item with the same name on that page (those are shown in the item row)
  otherGroups(pageIndex: number, takeoffs: TakeoffItem[]): MarkupGroup[] {
    const names = new Set(takeoffs.map(t => t.name));
    return this.store.markupGroups(pageIndex).filter(g => !names.has(g.name));
  }

  allSelected(list: readonly object[]): boolean {
    return list.length > 0 && list.every(el => this.store.selection.includes(el as never));
  }

  icon(item: TakeoffItem): string { return kindIcon(item.kind); }
  unit(item: TakeoffItem): string { return kindUnit(item.kind); }

  quantityText(item: TakeoffItem, pageIndex: number): string {
    const q = this.store.elementQuantity(item, pageIndex);
    return item.kind === 'count' ? q.toFixed(0) : q.toFixed(2);
  }

  // Green dot of an item: keeps measuring that element on the page shown (even if the row is
  // under another page). Click again to stop.
  toggleItem(item: TakeoffItem): void {
    if (this.store.selectedItemId === item.id) this.store.select(null);
    else this.store.select(item.id);
  }

  toggleGroup(group: MarkupGroup): void {
    if (this.store.isContinuing(group.markups)) this.store.select(null);
    else this.store.continueGroup(group.markups);
  }

  showFirst(group: MarkupGroup): void {
    const first: Markup | undefined = group.markups[0];
    if (first) this.store.showElement(first);
  }

  // MARK: - Renaming in the row (double click). Enter saves, Esc cancels, clicking elsewhere also saves
  startEdit(key: string, name: string): void {
    this.editText.set(name);
    this.editingKey.set(key);
    setTimeout(() => (document.querySelector('.tree input.rename') as HTMLInputElement | null)?.select(), 0);
  }

  private takeEdit(): string | null {
    if (this.editingKey() === null) return null;
    this.editingKey.set(null);
    return this.editText().trim();
  }

  finishPageRename(index: number): void {
    const name = this.takeEdit();
    if (name !== null) this.store.renamePage(index, name);         // empty = default name
  }

  finishItemRename(item: TakeoffItem): void {
    const name = this.takeEdit();
    if (name) this.store.renameItem(item.id, name);                // empty = keep the old name
  }

  finishGroupRename(group: MarkupGroup): void {
    const name = this.takeEdit();
    if (name) this.store.renameMarkups(group.markups, name);
  }
}
