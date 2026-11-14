import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Markup } from '../../models/elements';
import { TakeoffItem, kindIcon, kindUnit } from '../../models/takeoff';
import { DrawingStore, MarkupGroup } from '../../services/drawing.store';

// Element tree: pages › takeoff items and groups of PDF markups — port of TakeoffTreeView.swift
@Component({
  selector: 'app-takeoff-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tree' },
  template: `
    @let s = store.watch();
    @if (!s.hasDocument) {
      <div class="secondary pad">Open a drawing</div>
    }
    @for (page of s.pages; track $index; let index = $index) {
      @let groups = s.markupGroups(index);
      @let takeoffs = s.itemsOnPage(index);
      @let isCurrent = index === s.currentPageIndex;
      <!-- Page row: double click or right click to rename it. The page shown in the plan is highlighted -->
      <div
        class="tree-row page-row"
        [class.current]="isCurrent"
        (click)="s.goTo(index)"
        (dblclick)="startEdit('page-' + index, s.pageNames.get(index) ?? '')"
        (contextmenu)="
          $event.preventDefault(); startEdit('page-' + index, s.pageNames.get(index) ?? '')
        "
      >
        <button class="disclosure" (click)="$event.stopPropagation(); toggle('page-' + index)">
          <span class="icon small">{{
            isOpen('page-' + index) ? 'expand_more' : 'chevron_right'
          }}</span>
        </button>
        <span class="icon small">{{ isCurrent ? 'description' : 'draft' }}</span>
        @if (editingKey() === 'page-' + index) {
          <input
            class="rename"
            [value]="editText()"
            placeholder="Leave empty for the default name"
            (click)="$event.stopPropagation()"
            (input)="editText.set($any($event.target).value)"
            (keydown.enter)="finishPageRename(index)"
            (keydown.escape)="editingKey.set(null)"
            (blur)="finishPageRename(index)"
            [attr.autofocus]="true"
          />
        } @else {
          <span class="name">{{ s.pageName(index) }}</span>
        }
        <span class="count">{{ countOf(groups) + takeoffs.length }}</span>
      </div>

      @if (isOpen('page-' + index)) {
        <div class="tree-children">
          <!-- App measurements (green dot = keep measuring with that item) -->
          @for (item of takeoffs; track item.id) {
            @let active = s.selectedItemId === item.id;
            @let measured = s.measurementsOf(item.id, index);
            @let selected = measured.length > 0 && allSelected(measured);
            <div
              class="tree-row"
              [class.active]="active"
              [class.selected]="!active && selected"
              (click)="s.goTo(index); s.selectElements(measured)"
              (dblclick)="startEdit('item-' + item.id, item.name)"
              (contextmenu)="$event.preventDefault(); startEdit('item-' + item.id, item.name)"
            >
              <button
                class="dot"
                [class.on]="active"
                [title]="active ? 'Stop measuring' : 'Continue measuring'"
                (click)="$event.stopPropagation(); toggleItem(item, index)"
              ></button>
              <span class="icon small" [style.color]="item.color">{{ icon(item) }}</span>
              @if (editingKey() === 'item-' + item.id) {
                <input
                  class="rename"
                  [value]="editText()"
                  (click)="$event.stopPropagation()"
                  (input)="editText.set($any($event.target).value)"
                  (keydown.enter)="finishItemRename(item)"
                  (keydown.escape)="editingKey.set(null)"
                  (blur)="finishItemRename(item)"
                />
              } @else {
                <span class="name" [class.dimmed]="!item.isVisible">{{ item.name }}</span>
              }
              <span class="qty">{{ quantityText(item, index) }} {{ unit(item) }}</span>
              <span class="swatch" [style.background]="item.color"></span>
              <button
                class="bulb"
                [class.on]="item.isVisible"
                (click)="$event.stopPropagation(); s.toggleVisibility(item.id)"
              >
                <span class="icon small">lightbulb</span>
              </button>
              <button
                class="row-delete"
                title="Delete"
                (click)="$event.stopPropagation(); s.selectElements(measured); s.deleteSelected()"
              >
                <span class="icon small">delete</span>
              </button>
            </div>
          }
          @if (groups.length === 0 && takeoffs.length === 0) {
            <div class="secondary small pad-left">No annotations</div>
          }

          <!-- Groups of PDF markups (same name) -->
          @for (group of groups; track group.name) {
            @let key = 'group-' + index + '-' + group.name;
            @let active = s.isContinuing(group.markups);
            <div
              class="tree-row"
              [class.active]="active"
              [class.selected]="!active && allSelected(group.markups)"
              (click)="s.selectElements(group.markups); showFirst(group)"
              (dblclick)="startEdit(key, group.name)"
              (contextmenu)="$event.preventDefault(); startEdit(key, group.name)"
            >
              <button class="disclosure" (click)="$event.stopPropagation(); toggle(key)">
                <span class="icon small">{{ isOpen(key) ? 'expand_more' : 'chevron_right' }}</span>
              </button>
              <!-- Green dot: keep adding the same element with every click on the plan -->
              <button
                class="dot"
                [class.on]="active"
                [title]="active ? 'Stop counting' : 'Continue counting'"
                (click)="$event.stopPropagation(); toggleGroup(group, index)"
              ></button>
              <span class="small-dot" [style.background]="group.color"></span>
              @if (editingKey() === key) {
                <input
                  class="rename"
                  [value]="editText()"
                  (click)="$event.stopPropagation()"
                  (input)="editText.set($any($event.target).value)"
                  (keydown.enter)="finishGroupRename(group)"
                  (keydown.escape)="editingKey.set(null)"
                  (blur)="finishGroupRename(group)"
                />
              } @else {
                <span class="name" [class.dimmed]="!group.isVisible">{{ group.name }}</span>
              }
              <span class="qty">{{ group.markups.length }}</span>
              <span class="swatch" [style.background]="group.color"></span>
              <button
                class="bulb"
                [class.on]="group.isVisible"
                (click)="$event.stopPropagation(); s.setVisible(group.markups, !group.isVisible)"
              >
                <span class="icon small">lightbulb</span>
              </button>
              <button
                class="row-delete"
                title="Delete"
                (click)="
                  $event.stopPropagation(); s.selectElements(group.markups); s.deleteSelected()
                "
              >
                <span class="icon small">delete</span>
              </button>
            </div>
            @if (isOpen(key)) {
              <div class="tree-children">
                <!-- A single markup: click selects only that one -->
                @for (m of group.markups; track m.id; let i = $index) {
                  <div
                    class="tree-row"
                    [class.selected]="s.isSelected(m)"
                    (click)="s.selectElements([m]); s.showElement(m)"
                  >
                    <span class="icon small" [style.color]="m.color ?? '#8E8E93'"
                      >check_box_outline_blank</span
                    >
                    <span class="name" [class.dimmed]="!m.visible">{{
                      m.contents || m.typeName + ' ' + (i + 1)
                    }}</span>
                    <button
                      class="bulb"
                      [class.on]="m.visible"
                      (click)="$event.stopPropagation(); s.setVisible([m], !m.visible)"
                    >
                      <span class="icon small">lightbulb</span>
                    </button>
                  </div>
                }
              </div>
            }
          }
        </div>
      }
    }
  `,
})
export class TakeoffTree {
  readonly store = inject(DrawingStore);
  private readonly open = signal(new Set<string>());
  readonly editingKey = signal<string | null>(null);
  readonly editText = signal('');

  isOpen(key: string): boolean {
    return this.open().has(key);
  }

  toggle(key: string): void {
    this.open.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  countOf(groups: MarkupGroup[]): number {
    return groups.reduce((sum, g) => sum + g.markups.length, 0);
  }

  allSelected(list: readonly object[]): boolean {
    return list.length > 0 && list.every((el) => this.store.selection.includes(el as never));
  }

  icon(item: TakeoffItem): string {
    return kindIcon(item.kind);
  }
  unit(item: TakeoffItem): string {
    return kindUnit(item.kind);
  }

  quantityText(item: TakeoffItem, pageIndex: number): string {
    const q = this.store.quantity(item, pageIndex);
    return item.kind === 'count' ? q.toFixed(0) : q.toFixed(2);
  }

  // Green dot of an item: click again to stop
  toggleItem(item: TakeoffItem, pageIndex: number): void {
    if (this.store.selectedItemId === item.id) {
      this.store.select(null);
    } else {
      this.store.goTo(pageIndex);
      this.store.select(item.id);
    }
  }

  toggleGroup(group: MarkupGroup, pageIndex: number): void {
    if (this.store.isContinuing(group.markups)) {
      this.store.select(null);
    } else {
      this.store.goTo(pageIndex);
      this.store.continueGroup(group.markups);
    }
  }

  showFirst(group: MarkupGroup): void {
    const first: Markup | undefined = group.markups[0];
    if (first) this.store.showElement(first);
  }

  // MARK: - Renaming in the row (double click). Enter saves, Esc cancels, clicking elsewhere also saves
  startEdit(key: string, name: string): void {
    this.editText.set(name);
    this.editingKey.set(key);
    setTimeout(
      () => (document.querySelector('.tree input.rename') as HTMLInputElement | null)?.select(),
      0,
    );
  }

  private takeEdit(): string | null {
    if (this.editingKey() === null) return null;
    this.editingKey.set(null);
    return this.editText().trim();
  }

  finishPageRename(index: number): void {
    const name = this.takeEdit();
    if (name !== null) this.store.renamePage(index, name); // empty = default name
  }

  finishItemRename(item: TakeoffItem): void {
    const name = this.takeEdit();
    if (name) this.store.renameItem(item.id, name); // empty = keep the old name
  }

  finishGroupRename(group: MarkupGroup): void {
    const name = this.takeEdit();
    if (name) this.store.renameMarkups(group.markups, name);
  }
}
