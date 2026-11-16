import { Injectable, computed, inject, signal } from '@angular/core';
import { EstimateLayout, newId, starterLayouts } from '../models/templates';
import { DrawingStore } from './drawing.store';

const STORAGE_KEY = 'estimateLayouts';

// Estimating Layouts (PlanSwift style): named sets of estimate columns (order, widths, decimals…)
// and groups, kept in this browser and shared by every document. Clicking a layout shows its
// columns and groups; Save keeps the current ones in the selected layout.
// Import / Export move layouts between computers as a .json file.
@Injectable({ providedIn: 'root' })
export class EstimateLayouts {
  private readonly store = inject(DrawingStore);
  private readonly rev = signal(0);
  readonly watch = computed(() => { this.rev(); return this; }, { equal: () => false });

  layouts: EstimateLayout[] = load();
  renaming: string | null = null;                 // layout being renamed in the list

  private touch(): void { this.rev.update(v => v + 1); }

  private changed(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.layouts)); } catch { /* not remembered */ }
    this.touch();
  }

  // Layout last used with this file (remembered per file name)
  get activeId(): string | null {
    const id = readSetting(this.fileKey);
    return id && this.layouts.some(l => l.id === id) ? id : null;
  }

  private set activeId(id: string | null) {
    if (id) writeSetting(this.fileKey, id);
    this.touch();
  }

  private get fileKey(): string {
    return `estimateLayout:${this.store.fileName}`;
  }

  get active(): EstimateLayout | undefined {
    return this.layouts.find(l => l.id === this.activeId);
  }

  // The columns or groups changed after loading the layout
  get isModified(): boolean {
    const layout = this.active;
    if (!layout) return false;
    const e = this.store.estimate;
    return JSON.stringify(layout.columns) !== JSON.stringify(e.columns)
      || (!!layout.groups && JSON.stringify(layout.groups) !== JSON.stringify(e.groups));
  }

  // Shows the layout's columns (and its groups, if it has them) in the estimate.
  // One Undo brings the previous ones back.
  apply(id: string): void {
    const layout = this.layouts.find(l => l.id === id);
    const s = this.store;
    if (!layout || !s.hasDocument) return;
    this.activeId = id;
    s.checkpoint();
    s.estimate.columns = structuredClone(layout.columns);
    if (layout.groups) s.estimate.groups = structuredClone(layout.groups);
    s.estimateChanged();
  }

  // Save: the current columns go into the selected layout
  save(): void {
    const layout = this.active;
    if (!layout) {
      this.saveAsNew();
      return;
    }
    layout.columns = structuredClone(this.store.estimate.columns);
    layout.groups = structuredClone(this.store.estimate.groups);
    this.changed();
    this.store.showToast(`Saved layout "${layout.name}"`);
  }

  // New: a layout with the current columns, named right away
  saveAsNew(): void {
    const used = new Set(this.layouts.map(l => l.name));
    let n = this.layouts.length + 1;
    while (used.has(`Layout ${n}`)) n++;
    const layout: EstimateLayout = {
      id: newId('layout'), name: `Layout ${n}`, columns: structuredClone(this.store.estimate.columns),
      groups: structuredClone(this.store.estimate.groups),
    };
    this.layouts.push(layout);
    this.renaming = layout.id;
    this.activeId = layout.id;
    this.changed();
  }

  rename(id: string, name: string): void {
    this.renaming = null;
    const layout = this.layouts.find(l => l.id === id);
    const trimmed = name.trim();
    if (layout && trimmed) layout.name = trimmed;
    this.changed();
  }

  startRename(id: string): void {
    this.renaming = id;
    this.touch();
  }

  // The last layout can't be deleted
  delete(id: string): void {
    if (this.layouts.length <= 1) return;
    this.layouts = this.layouts.filter(l => l.id !== id);
    this.changed();
  }

  // Move a layout up or down in the list
  move(id: string, step: number): void {
    const i = this.layouts.findIndex(l => l.id === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= this.layouts.length) return;
    [this.layouts[i], this.layouts[j]] = [this.layouts[j], this.layouts[i]];
    this.changed();
  }

  // Default, Takeoff View and Cost View come back as they were (custom layouts stay)
  restoreBuiltIns(): void {
    for (const builtIn of starterLayouts()) {
      const i = this.layouts.findIndex(l => l.id === builtIn.id);
      if (i >= 0) this.layouts[i] = builtIn; else this.layouts.push(builtIn);
    }
    this.changed();
  }

  // MARK: - Import / Export (.json)
  exportLayouts(): void {
    const blob = new Blob([JSON.stringify(this.layouts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CadrafterPro Layouts.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Imported layouts are added to the list (a name already used gets a number)
  importLayouts(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as unknown;
        const list = (Array.isArray(data) ? data : [data]) as Partial<EstimateLayout>[];
        const valid = list.filter(l => typeof l.name === 'string' && Array.isArray(l.columns) && l.columns.length);
        if (valid.length === 0) throw new Error('No layouts');
        const used = new Set(this.layouts.map(l => l.name));
        for (const l of valid) {
          let name = l.name!;
          for (let n = 2; used.has(name); n++) name = `${l.name} ${n}`;
          used.add(name);
          this.layouts.push({ id: newId('layout'), name, columns: l.columns!, groups: Array.isArray(l.groups) ? l.groups : undefined });
        }
        this.changed();
        this.store.showToast(`Imported ${valid.length} ${valid.length === 1 ? 'layout' : 'layouts'}`);
      } catch {
        this.store.showToast('That file has no estimating layouts', true);
      }
    });
    input.click();
  }
}

function load(): EstimateLayout[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as EstimateLayout[] | null;
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fall back to the built-in layouts */ }
  return starterLayouts();
}

function readSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
}
