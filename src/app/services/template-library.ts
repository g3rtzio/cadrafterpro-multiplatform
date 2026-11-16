import { Injectable, computed, inject, signal } from '@angular/core';
import { Part, PropertyDef, evaluate, findProp, partTemplate } from '../models/estimate';
import { TakeoffKind, kindTitle } from '../models/takeoff';
import {
  TakeoffTemplate, TemplateFolder, TemplateLibraryData, TemplatePart, newId, setFormula, starterLibrary, templateProps,
} from '../models/templates';
import { DrawingStore } from './drawing.store';

const STORAGE_KEY = 'templateLibrary';

// Selected entry of the Templates tab: a folder, a template, or a part of a template
export type TemplateSelection =
  | { type: 'folder'; id: string }
  | { type: 'template'; id: string }
  | { type: 'part'; templateId: string; id: string }
  | null;

// Template library ("Templates" tab). Kept in this browser (localStorage), shared by every document.
@Injectable({ providedIn: 'root' })
export class TemplateLibrary {
  private readonly store = inject(DrawingStore);
  private readonly rev = signal(0);
  // Views read this so they redraw after every change
  readonly watch = computed(() => { this.rev(); return this; }, { equal: () => false });

  data: TemplateLibraryData = load();
  selection: TemplateSelection = null;
  collapsed = new Set<string>();                  // folders and templates closed in the tree
  renaming: string | null = null;                 // folder being renamed in the tree

  private touch(): void { this.rev.update(v => v + 1); }

  private changed(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* not remembered */ }
    this.touch();
  }

  // MARK: - Lookups
  folder(id: string | null): TemplateFolder | undefined {
    return id ? this.data.folders.find(f => f.id === id) : undefined;
  }

  template(id: string | null | undefined): TakeoffTemplate | undefined {
    return id ? this.data.templates.find(t => t.id === id) : undefined;
  }

  subFolders(parentId: string | null): TemplateFolder[] {
    return this.data.folders.filter(f => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  }

  templatesIn(folderId: string | null): TakeoffTemplate[] {
    return this.data.templates.filter(t => t.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  }

  partsOf(template: TakeoffTemplate, parentId: string | null): TemplatePart[] {
    return template.parts.filter(p => p.parentId === parentId);
  }

  partName(part: TemplatePart): string {
    return String(evaluate({ props: part.props, takeoff: null, parent: null }, 'Name').value || 'New Part');
  }

  // Template being shown on the right (the selected one, or the one that owns the selected part)
  get selectedTemplate(): TakeoffTemplate | undefined {
    const s = this.selection;
    if (s?.type === 'template') return this.template(s.id);
    if (s?.type === 'part') return this.template(s.templateId);
    return undefined;
  }

  get selectedPart(): TemplatePart | undefined {
    const s = this.selection;
    return s?.type === 'part' ? this.template(s.templateId)?.parts.find(p => p.id === s.id) : undefined;
  }

  // Folder where new entries go: the selected folder, or the folder of the selected template
  private get targetFolderId(): string | null {
    const s = this.selection;
    if (s?.type === 'folder') return s.id;
    return this.selectedTemplate?.folderId ?? null;
  }

  select(selection: TemplateSelection): void {
    this.selection = selection;
    this.touch();
  }

  toggle(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.touch();
  }

  // MARK: - Folders
  newFolder(): void {
    const parentId = this.targetFolderId;
    const used = new Set(this.subFolders(parentId).map(f => f.name));
    let n = 1;
    while (used.has(n === 1 ? 'New Folder' : `New Folder ${n}`)) n++;
    const folder: TemplateFolder = { id: newId('folder'), name: n === 1 ? 'New Folder' : `New Folder ${n}`, parentId };
    this.data.folders.push(folder);
    if (parentId) this.collapsed.delete(parentId);
    this.selection = { type: 'folder', id: folder.id };
    this.renaming = folder.id;
    this.changed();
  }

  renameFolder(id: string, name: string): void {
    this.renaming = null;
    const folder = this.folder(id);
    const trimmed = name.trim();
    if (folder && trimmed) folder.name = trimmed;
    this.changed();
  }

  // MARK: - Templates
  newTemplate(kind: TakeoffKind): void {
    const folderId = this.targetFolderId;
    const used = new Set(this.data.templates.map(t => t.name));
    let n = 1;
    while (used.has(`New ${kindTitle(kind)} ${n}`)) n++;
    const name = `New ${kindTitle(kind)} ${n}`;
    const template: TakeoffTemplate = {
      id: newId('tpl'), folderId, name, kind, color: defaultColor(kind), props: templateProps(kind, name), parts: [],
    };
    this.data.templates.push(template);
    if (folderId) this.collapsed.delete(folderId);
    this.selection = { type: 'template', id: template.id };
    this.changed();
  }

  // Name, type and color of a template (the Name property follows the name)
  updateTemplate(id: string, change: Partial<Pick<TakeoffTemplate, 'name' | 'kind' | 'color'>>): void {
    const t = this.template(id);
    if (!t) return;
    if (change.name !== undefined) {
      const name = change.name.trim();
      if (!name) return;
      t.name = name;
      setFormula(t.props, 'Name', name);
    }
    if (change.kind && change.kind !== t.kind) {
      // A new type brings the Qty formula and units of that type; the other properties stay
      const fresh = templateProps(change.kind, t.name);
      for (const name of ['Qty', 'Type']) {
        const target = findProp(t.props, name);
        const source = findProp(fresh, name);
        if (target && source) { target.formula = source.formula; target.units = source.units; }
      }
      t.kind = change.kind;
    }
    if (change.color) t.color = change.color;
    this.changed();
  }

  // One property of the template or of one of its parts
  updateProp(owner: { props: PropertyDef[] }, name: string, change: Partial<PropertyDef>): void {
    const def = findProp(owner.props, name);
    if (!def || def.takeoff) return;
    Object.assign(def, change);
    const t = this.selectedTemplate;
    if (t && owner === t && def.name === 'Name' && change.formula !== undefined && change.formula.trim()) {
      t.name = change.formula.trim();
    }
    this.changed();
  }

  duplicate(): void {
    const t = this.selectedTemplate;
    if (!t) return;
    const copy: TakeoffTemplate = { ...structuredClone(t), id: newId('tpl'), name: `${t.name} Copy` };
    setFormula(copy.props, 'Name', copy.name);
    // Parts get new ids; their links to each other follow
    const ids = new Map(copy.parts.map(p => [p.id, newId('tpart')]));
    copy.parts = copy.parts.map(p => ({ ...p, id: ids.get(p.id)!, parentId: p.parentId ? ids.get(p.parentId) ?? null : null }));
    this.data.templates.push(copy);
    this.selection = { type: 'template', id: copy.id };
    this.changed();
  }

  // MARK: - Parts of a template
  // New part under the template, or under the selected part
  newPart(): void {
    const t = this.selectedTemplate;
    if (!t) return;
    const parentId = this.selectedPart?.id ?? null;
    const part: TemplatePart = { id: newId('tpart'), parentId, props: partTemplate() };
    t.parts.push(part);
    this.collapsed.delete(t.id);
    if (parentId) this.collapsed.delete(parentId);
    this.selection = { type: 'part', templateId: t.id, id: part.id };
    this.changed();
  }

  // MARK: - Delete (a folder takes everything inside it)
  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (s.type === 'part') {
      const t = this.template(s.templateId);
      if (!t) return;
      const gone = descendants(t.parts, s.id);
      t.parts = t.parts.filter(p => !gone.has(p.id));
      this.selection = { type: 'template', id: t.id };
    } else if (s.type === 'template') {
      this.data.templates = this.data.templates.filter(t => t.id !== s.id);
      this.selection = null;
    } else {
      const gone = new Set<string>([s.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of this.data.folders) {
          if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) { gone.add(f.id); grew = true; }
        }
      }
      this.data.folders = this.data.folders.filter(f => !gone.has(f.id));
      this.data.templates = this.data.templates.filter(t => !t.folderId || !gone.has(t.folderId));
      this.selection = null;
    }
    this.changed();
  }

  // MARK: - Drag and drop in the tree: templates and folders move into folders (null = top level)
  move(kind: 'folder' | 'template', id: string, folderId: string | null): void {
    if (kind === 'template') {
      const t = this.template(id);
      if (!t || t.folderId === folderId) return;
      t.folderId = folderId;
    } else {
      const f = this.folder(id);
      if (!f || f.id === folderId || f.parentId === folderId) return;
      // A folder can't go inside itself or one of its subfolders
      for (let p = this.folder(folderId); p; p = this.folder(p.parentId)) if (p.id === id) return;
      f.parentId = folderId;
    }
    if (folderId) this.collapsed.delete(folderId);
    this.changed();
  }

  // MARK: - Use a template: a takeoff item with its properties and parts, ready to measure
  useTemplate(id: string | undefined = this.selectedTemplate?.id): void {
    const t = this.template(id);
    const s = this.store;
    if (!t) return;
    if (!s.hasDocument) {
      s.showToast('Open a drawing first', true);
      return;
    }
    s.showTab('Home');
    // Already in the document: continue measuring with it
    const existing = s.items.find(i => i.name === t.name && i.kind === t.kind);
    if (existing) {
      s.select(existing.id);
      return;
    }
    s.checkpoint();
    const props = structuredClone(t.props);
    setFormula(props, 'Name', t.name);
    if (!s.estimate.elementProps[t.name]) s.estimate.elementProps[t.name] = props;
    // Parts: the template's top parts hang from the new element, the rest keep their parents
    if (!s.estimate.parts.some(p => p.parentKey === t.name)) {
      const ids = new Map(t.parts.map(p => [p.id, `part-${newId('t')}`]));
      for (const p of t.parts) {
        const part: Part = {
          id: ids.get(p.id)!, parentKey: p.parentId ? ids.get(p.parentId) ?? t.name : t.name, props: structuredClone(p.props),
        };
        s.estimate.parts.push(part);
      }
    }
    s.estimateChanged();
    s.addItem(t.name, t.kind, t.color);
    s.showToast(`Measuring with "${t.name}"`);
  }

  // MARK: - Save an element of the document as a template (with its properties and parts)
  documentElements(): { name: string; color: string }[] {
    return this.store.estimateRows().filter(r => r.kind === 'element').map(r => ({ name: r.name, color: r.color ?? '' }));
  }

  addFromDocument(name: string): void {
    const s = this.store;
    const row = s.estimateRows().find(r => r.kind === 'element' && r.key === name);
    if (!row) return;
    const item = s.items.find(i => i.name === name);
    const info = s.elementInfo(name);
    const kind: TakeoffKind = item?.kind ?? (info?.kind === 'area' ? 'area' : info?.kind === 'count' ? 'count' : 'length');
    const props = structuredClone(s.rowProps(name));
    // Parts under the element and under its parts
    const keep = descendantsByKey(s.estimate.parts, name);
    const ids = new Map([...keep].map(p => [p.id, newId('tpart')]));
    const parts: TemplatePart[] = [...keep].map(p => ({
      id: ids.get(p.id)!, parentId: p.parentKey && ids.has(p.parentKey) ? ids.get(p.parentKey)! : null,
      props: structuredClone(p.props),
    }));
    const template: TakeoffTemplate = {
      id: newId('tpl'), folderId: this.targetFolderId, name, kind, color: item?.color ?? row.color ?? defaultColor(kind),
      props, parts,
    };
    this.data.templates.push(template);
    if (template.folderId) this.collapsed.delete(template.folderId);
    this.selection = { type: 'template', id: template.id };
    this.changed();
    s.showToast(`Saved "${name}" as a template`);
  }

  // MARK: - Import / Export (.json), to back up the library or share it
  exportLibrary(): void {
    const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CadrafterPro Templates.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  importLibrary(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as Partial<TemplateLibraryData>;
        if (!Array.isArray(data.templates)) throw new Error('No templates');
        // Everything goes into a new folder named after the file, with new ids
        const root: TemplateFolder = { id: newId('folder'), name: file.name.replace(/\.json$/i, ''), parentId: null };
        const folderIds = new Map((data.folders ?? []).map(f => [f.id, newId('folder')]));
        this.data.folders.push(root, ...(data.folders ?? []).map(f => ({
          id: folderIds.get(f.id)!, name: f.name, parentId: f.parentId ? folderIds.get(f.parentId) ?? root.id : root.id,
        })));
        this.data.templates.push(...data.templates.map(t => ({
          ...t, id: newId('tpl'), folderId: t.folderId ? folderIds.get(t.folderId) ?? root.id : root.id,
          parts: Array.isArray(t.parts) ? t.parts : [], props: Array.isArray(t.props) ? t.props : templateProps(t.kind, t.name),
        })));
        this.selection = { type: 'folder', id: root.id };
        this.changed();
        this.store.showToast(`Imported ${data.templates.length} templates`);
      } catch {
        this.store.showToast('That file is not a template library', true);
      }
    });
    input.click();
  }
}

function defaultColor(kind: TakeoffKind): string {
  return { area: '#34C759', length: '#007AFF', segment: '#FF9500', count: '#FF3B30' }[kind];
}

// A part and every part below it
function descendants(parts: TemplatePart[], id: string): Set<string> {
  const gone = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parts) if (p.parentId && gone.has(p.parentId) && !gone.has(p.id)) { gone.add(p.id); grew = true; }
  }
  return gone;
}

// Estimate parts below an element (directly or through other parts)
function descendantsByKey(parts: Part[], key: string): Set<Part> {
  const keys = new Set<string>([key]);
  const found = new Set<Part>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parts) {
      if (p.parentKey && keys.has(p.parentKey) && !found.has(p)) { found.add(p); keys.add(p.id); grew = true; }
    }
  }
  return found;
}

function load(): TemplateLibraryData {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) {
      const data = JSON.parse(text) as Partial<TemplateLibraryData>;
      if (Array.isArray(data.folders) && Array.isArray(data.templates)) {
        return { version: 1, folders: data.folders, templates: data.templates };
      }
    }
  } catch { /* fall back to the starter library */ }
  return starterLibrary();
}
