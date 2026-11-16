import { ColumnDef, EstimateGroup, PropertyDef, defaultColumns, elementTemplate, findProp, partTemplate } from './estimate';
import { COLORS, TakeoffKind } from './takeoff';

// Templates (PlanSwift "Templates" pane): reusable takeoff items with their properties and parts,
// kept in this browser and shared by every document. Using a template creates a takeoff item
// with the same name, type and color, and copies its properties and parts into the estimate.

export interface TemplateFolder {
  id: string;
  name: string;
  parentId: string | null;        // null = top level
}

// A part inside a template (hangs from the template itself or from another part)
export interface TemplatePart {
  id: string;
  parentId: string | null;        // null = under the template
  props: PropertyDef[];
}

export interface TakeoffTemplate {
  id: string;
  folderId: string | null;        // null = top level
  name: string;
  kind: TakeoffKind;
  color: string;
  props: PropertyDef[];           // element properties (Name, Qty, Cost Each…)
  parts: TemplatePart[];
  isPart?: boolean;               // part template: added under an item of the estimate (not measured); parts = its sub-parts
}

export interface TemplateLibraryData {
  version: 1;
  folders: TemplateFolder[];
  templates: TakeoffTemplate[];
}

// Estimating Layout (PlanSwift "Estimating Layouts"): a saved set of estimate columns
// (with their order and widths) and, once saved from a document, its groups
export interface EstimateLayout {
  id: string;
  name: string;
  columns: ColumnDef[];
  groups?: EstimateGroup[];       // missing = loading the layout leaves the groups as they are
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Properties of an element of this takeoff type (segment measures like a linear)
export function templateProps(kind: TakeoffKind, name: string): PropertyDef[] {
  return elementTemplate(kind === 'area' ? 'area' : kind === 'count' ? 'count' : 'length', name);
}

// Sets a property's formula (does nothing if the list doesn't have it)
export function setFormula(props: PropertyDef[], name: string, formula: string): void {
  const def = findProp(props, name);
  if (def) def.formula = formula;
}

// A few examples so the library isn't empty the first time
export function starterLibrary(): TemplateLibraryData {
  const folder = (name: string): TemplateFolder => ({ id: newId('folder'), name, parentId: null });
  const base = folder('Cadrafter Base');
  const item = (name: string, kind: TakeoffKind, color: string, cost: number,
    parts: { name: string; cost: number }[] = []): TakeoffTemplate => {
    const props = templateProps(kind, name);
    setFormula(props, 'Cost Each', String(cost));
    return {
      id: newId('tpl'), folderId: base.id, name, kind, color, props,
      parts: parts.map(p => {
        const partProps = partTemplate(p.name);
        setFormula(partProps, 'Cost Each', String(p.cost));
        return { id: newId('tpart'), parentId: null, props: partProps };
      }),
    };
  };
  return {
    version: 1,
    folders: [base],
    templates: [
      item('Concrete Slab', 'area', COLORS.green, 0, [{ name: 'Concrete', cost: 0 }, { name: 'Wire Mesh', cost: 0 }]),
      item('Footing', 'length', COLORS.blue, 0),
      item('Duplex Outlet', 'count', COLORS.red, 0, [{ name: 'Box', cost: 0 }, { name: 'Cover Plate', cost: 0 }]),
      partItem(base.id, 'Labor Hour', 0),
    ],
  };
}

// A part template of the starter library
function partItem(folderId: string, name: string, cost: number): TakeoffTemplate {
  const props = partTemplate(name);
  setFormula(props, 'Cost Each', String(cost));
  return { id: newId('tpl'), folderId, name, kind: 'count', color: PART_COLOR, props, parts: [], isPart: true };
}

export const PART_COLOR = '#FF9500';

// Built-in layouts: the default columns, a takeoff-only view and a cost view
export function starterLayouts(): EstimateLayout[] {
  const col = (name: string, type: 'number' | 'text', showUnits = false, decimals = 2): ColumnDef =>
    ({ id: `col-${name}`, name, type, visible: true, showUnits, decimals });
  return [
    { id: 'layout-default', name: 'Default', columns: defaultColumns() },
    {
      id: 'layout-takeoff', name: 'Takeoff View', columns: [
        col('Name', 'text'), col('Color', 'text'), col('Qty', 'number', true),
        col('Area', 'number', true), col('Linear Total', 'number', true), col('Point Count', 'number', false, 0),
        col('Pages', 'text'),
      ],
    },
    {
      id: 'layout-cost', name: 'Cost View', columns: [
        col('Name', 'text'), col('Description', 'text'), col('Qty', 'number', true), col('Cost Each', 'number'),
        col('Cost Total', 'number'), col('Markup %', 'number'), col('Price Each', 'number'), col('Price Total', 'number'),
      ],
    },
  ];
}
