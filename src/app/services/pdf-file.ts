import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { Markup, Measurement, randomName } from '../models/elements';
import { Pt, Rect, ScaleViewport, boundsOf, dashPattern, uid } from '../models/takeoff';

// Reads and writes the PDF file with pdf-lib (port of the PDFKit parts of DrawingViewModel,
// MeasurementAnnotation.applyBluebeamProperties and RevuPageScale.swift).
// pdf-lib edits the PDF objects directly, so the page scale (/VP) is written on the page itself:
// no incremental update is needed like on the Mac.

export interface OpenedPdf {
  lib: PDFDocument;
  markups: Markup[];
  pageScales: Map<number, number>; // page index → scale denominator
  viewports: ScaleViewport[];
  appData: string | null; // CadrafterPro estimate (properties, parts, columns, groups)
}

// One viewport to save: a region of the page with its own scale.
// The page scale is a viewport that covers the whole page.
export interface SaveViewport {
  name: string;
  bbox: Rect;
  feetPerPoint: number;
  text: string; // Revu scale text ("0.25 in = 1 ft")
}

export interface SaveMeasurement {
  m: Measurement;
  feetPerPoint: number;
  scaleText: string;
}

export interface SaveInput {
  measurements: SaveMeasurement[];
  markups: Markup[]; // only the changed ones are written
  removed: { pageIndex: number; ref: PDFRef }[];
  viewports: SaveViewport[][]; // one list per page (empty = no scale on that page)
  author: string;
  appData: string; // stored in the document catalog (/CadrafterPro); Revu ignores it
}

// MARK: - Opening

export async function readPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const markups: Markup[] = [];
  const pageScales = new Map<number, number>();
  const viewports: ScaleViewport[] = [];

  lib.getPages().forEach((page, pageIndex) => {
    // Markups
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const raw = annots!.get(i);
      const dict = annots!.lookupMaybe(i, PDFDict);
      if (!dict) continue;
      const m = readMarkup(dict, pageIndex);
      if (!m) continue;
      m.ref = raw instanceof PDFRef ? raw : null;
      if (!m.ref) continue; // direct objects can't be edited later
      markups.push(m);
    }

    // Scales already saved in the file (by Revu or by an earlier save).
    // A viewport that covers the whole page is the page scale; smaller ones are viewports.
    const media = page.getMediaBox();
    for (const v of readViewports(page.node)) {
      const coversPage = !v.bbox || v.bbox.w * v.bbox.h >= media.width * media.height * 0.9;
      if (coversPage) {
        pageScales.set(pageIndex, v.denominator);
      } else {
        viewports.push({
          id: uid(),
          name: v.name,
          pageIndex,
          rect: v.bbox!,
          denominator: v.denominator,
        });
      }
    }
  });
  const data = lib.catalog.lookup(PDFName.of('CadrafterPro'));
  const appData =
    data instanceof PDFString || data instanceof PDFHexString ? data.decodeText() : null;
  return { lib, markups, pageScales, viewports, appData };
}

function readMarkup(dict: PDFDict, pageIndex: number): Markup | null {
  const subtype = nameOf(dict, 'Subtype');
  if (!subtype) return null;
  const m = new Markup(pageIndex);
  m.subtype = subtype;
  m.intent = nameOf(dict, 'IT') ?? '';
  m.subject = textOf(dict, 'Subj') ?? '';
  m.contents = textOf(dict, 'Contents') ?? '';
  m.color = colorOf(dict, 'C');
  m.fillColor = colorOf(dict, 'IC');
  m.opacity = numberOf(dict, 'CA') ?? 1;
  m.fillOpacity = numberOf(dict, 'FillOpacity');
  const rect = numbersOf(dict, 'Rect');
  if (rect && rect.length === 4) {
    m.rect = {
      x: Math.min(rect[0], rect[2]),
      y: Math.min(rect[1], rect[3]),
      w: Math.abs(rect[2] - rect[0]),
      h: Math.abs(rect[3] - rect[1]),
    };
  }
  const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
  const border = numbersOf(dict, 'Border');
  m.lineWidth = (bs && numberOf(bs, 'W')) ?? (border && border.length >= 3 ? border[2] : 1);
  m.dashed = !!bs && nameOf(bs, 'S') === 'D';
  m.vertices = pairs(numbersOf(dict, 'Vertices'));
  m.line = pairs(numbersOf(dict, 'L'));
  const ink = dict.lookupMaybe(PDFName.of('InkList'), PDFArray);
  if (ink) {
    m.inkList = [];
    for (let i = 0; i < ink.size(); i++) {
      const path = ink.lookupMaybe(i, PDFArray);
      const pts = path ? pairs(arrayNumbers(path)) : null;
      if (pts) m.inkList.push(pts);
    }
  }
  m.multiply = (nameOf(dict, 'BM') ?? '').includes('Multiply');
  m.visible = ((numberOf(dict, 'F') ?? 0) & 2) === 0; // bit 2 = hidden
  return m;
}

// Viewports stored in a page: /BBox, /Name and /Measure → /X → /C and /U
function readViewports(page: PDFDict): { name: string; bbox: Rect | null; denominator: number }[] {
  const list = page.lookupMaybe(PDFName.of('VP'), PDFArray);
  if (!list) return [];
  const result: { name: string; bbox: Rect | null; denominator: number }[] = [];
  for (let i = 0; i < list.size(); i++) {
    const vp = list.lookupMaybe(i, PDFDict);
    const d = vp && viewportDenominator(vp);
    if (!vp || !d) continue;
    const b = numbersOf(vp, 'BBox');
    const bbox =
      b && b.length === 4
        ? {
            x: Math.min(b[0], b[2]),
            y: Math.min(b[1], b[3]),
            w: Math.abs(b[2] - b[0]),
            h: Math.abs(b[3] - b[1]),
          }
        : null;
    result.push({ name: textOf(vp, 'Name') ?? 'Viewport', bbox, denominator: d });
  }
  return result;
}

// Scale of one viewport dictionary as a denominator
function viewportDenominator(vp: PDFDict): number | null {
  const measure = vp.lookupMaybe(PDFName.of('Measure'), PDFDict);
  const x = measure?.lookupMaybe(PDFName.of('X'), PDFArray);
  const format = x?.lookupMaybe(0, PDFDict);
  const factor = format ? numberOf(format, 'C') : null;
  if (!format || !factor || factor <= 0) return null;
  // /C converts PDF points to the unit in /U
  const unit = (textOf(format, 'U') ?? 'ft').trim().toLowerCase();
  const inchesPerUnit: Record<string, number> = {
    ft: 12,
    "'": 12,
    in: 1,
    '"': 1,
    yd: 36,
    m: 1 / 0.0254,
    cm: 1 / 2.54,
    mm: 1 / 25.4,
  };
  const inches = inchesPerUnit[unit];
  if (!inches) return null;
  // real inches per paper inch = factor (units per point) × inches per unit × 72 points
  const d = factor * inches * 72;
  return isFinite(d) && d > 0 ? Math.round(d * 1000) / 1000 : null;
}

// MARK: - Saving

export async function writePdf(lib: PDFDocument, input: SaveInput): Promise<Uint8Array> {
  const pages = lib.getPages();
  const font = await lib.embedFont(StandardFonts.Helvetica);

  // Deleted elements leave the page
  for (const r of input.removed) removeAnnot(pages[r.pageIndex]?.node, r.ref);

  // Markups changed in the app (moved, renamed, hidden, copied)
  for (const m of input.markups) {
    const page = pages[m.pageIndex];
    if (!page) continue;
    if (!m.ref) {
      // New copy: clone the original object
      const source = m.template?.ref ? lib.context.lookupMaybe(m.template.ref, PDFDict) : undefined;
      if (!source) continue;
      const dict = source.clone(lib.context);
      ['IRT', 'RT', 'GroupNesting', 'Popup'].forEach((k) => dict.delete(PDFName.of(k)));
      dict.set(PDFName.of('NM'), PDFHexString.fromText(randomName()));
      m.ref = lib.context.register(dict);
      page.node.addAnnot(m.ref);
    }
    const dict = lib.context.lookupMaybe(m.ref, PDFDict);
    if (!dict) continue;
    writeMarkup(lib, dict, m);
    // A markup brought back by Undo after a save is no longer on the page: put it back
    const annots = page.node.Annots();
    if ((annots?.indexOf(m.ref) ?? -1) < 0) page.node.addAnnot(m.ref);
    m.dirty = false;
  }

  // App measurements: the object from the previous save is replaced by a new one
  for (const s of input.measurements) {
    const page = pages[s.m.pageIndex];
    if (!page) continue;
    if (s.m.pdfRef) removeAnnot(page.node, s.m.pdfRef);
    const dict = measurementDict(lib, font, s, input.author);
    s.m.pdfRef = lib.context.register(dict);
    page.node.addAnnot(s.m.pdfRef);
  }

  // Page scale and viewports for Revu (/VP)
  input.viewports.forEach((list, i) => {
    const node = pages[i]?.node;
    if (!node) return;
    if (list.length === 0) {
      node.delete(PDFName.of('VP'));
      return;
    }
    node.set(
      PDFName.of('VP'),
      lib.context.obj(
        list.map((v) => ({
          Type: 'Viewport',
          BBox: [v.bbox.x, v.bbox.y, v.bbox.x + v.bbox.w, v.bbox.y + v.bbox.h],
          Name: PDFString.of(ascii(v.name)),
          NM: PDFString.of(randomName()),
          Measure: measureDict(lib, v.feetPerPoint, v.text),
        })),
      ),
    );
  });

  lib.catalog.set(PDFName.of('CadrafterPro'), PDFHexString.fromText(input.appData));
  return lib.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function removeAnnot(page: PDFDict | undefined, ref: PDFRef): void {
  const annots = page?.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const i = annots?.indexOf(ref);
  if (annots && i !== undefined && i >= 0) annots.remove(i);
}

// Writes the editable fields of a markup back into its dictionary
function writeMarkup(lib: PDFDocument, dict: PDFDict, m: Markup): void {
  const r = m.rect;
  dict.set(PDFName.of('Rect'), lib.context.obj([r.x, r.y, r.x + r.w, r.y + r.h]));
  if (m.vertices) dict.set(PDFName.of('Vertices'), lib.context.obj(flat(m.vertices)));
  if (m.line) dict.set(PDFName.of('L'), lib.context.obj(flat(m.line)));
  if (m.inkList) dict.set(PDFName.of('InkList'), lib.context.obj(m.inkList.map(flat)));
  if (m.subject) dict.set(PDFName.of('Subj'), PDFHexString.fromText(m.subject));
  dict.set(PDFName.of('Contents'), PDFHexString.fromText(m.contents));
  if (m.color) dict.set(PDFName.of('C'), lib.context.obj(rgb(m.color)));
  if (m.fillColor) dict.set(PDFName.of('IC'), lib.context.obj(rgb(m.fillColor)));
  const flags = numberOf(dict, 'F') ?? 4;
  dict.set(PDFName.of('F'), PDFNumber.of(m.visible ? flags & ~2 : flags | 2));
  const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
  if (bs) bs.set(PDFName.of('W'), PDFNumber.of(m.lineWidth));
  else dict.set(PDFName.of('BS'), lib.context.obj({ W: m.lineWidth }));
}

// Same /Measure dictionary Revu writes
function measureDict(lib: PDFDocument, feetPerPoint: number, scaleText: string): PDFDict {
  const format = (unit: string, factor: number, extra: Record<string, PDFObject> = {}) => ({
    Type: 'NumberFormat',
    U: PDFString.of(unit),
    C: factor,
    D: 100,
    FD: true,
    SS: PDFString.of(''),
    ...extra,
  });
  return lib.context.obj({
    Type: 'Measure',
    Subtype: 'RL',
    R: PDFString.of(scaleText),
    X: [format('ft', feetPerPoint)], // PDF points → real feet
    D: [format('ft', 1)], // length
    A: [format('sf', 1)], // area
    V: [format('cu ft', 1)], // volume
    T: [format('°', 1, { PS: PDFString.of('') })], // angle
    TargetUnitConversion: 1 / 864, // feet per point at 1:1
  });
}

// App measurement as a Bluebeam Revu markup
function measurementDict(
  lib: PDFDocument,
  font: PDFFont,
  s: SaveMeasurement,
  author: string,
): PDFDict {
  const m = s.m;
  const isLine = m.kind === 'length' || m.kind === 'segment';
  const ap = appearance(lib, font, m);
  const bbox = ap.bbox;
  const pdfDate = PDFString.of(dateText(m.createdAt));
  const style = dashPattern(m.lineStyle, m.lineWidth).map((v) => Math.max(v, 1));

  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: isLine ? 'PolyLine' : 'Polygon',
    Rect: [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h],
    Subj: PDFHexString.fromText(m.name),
    Contents: PDFHexString.fromText(m.kind === 'count' ? '1' : m.contents),
    T: PDFHexString.fromText(author),
    NM: PDFString.of(m.nm),
    C: rgb(m.lineColor),
    CA: m.opacity,
    F: m.visible ? 4 : 6, // 4 = Print (not locked), so Revu can select it
    BS:
      m.lineStyle === 'Solid'
        ? { W: m.kind === 'count' ? 0 : m.lineWidth, S: 'S' }
        : { W: m.lineWidth, S: 'D', D: style },
    DS: PDFString.of(m.revuTextStyle), // caption font and color
    CreationDate: pdfDate,
    M: pdfDate,
    Label: PDFString.of(''),
    Version: 1,
    DepthUnit: [
      {
        Type: 'NumberFormat',
        U: PDFString.of('ft'),
        C: 1 / 864,
        D: 100,
        FD: true,
        SS: PDFString.of(''),
      },
    ],
    AP: { N: ap.ref },
  };

  switch (m.kind) {
    case 'count':
      Object.assign(dict, {
        IC: rgb(m.lineColor), // circle fill
        IT: 'PolygonCount',
        MeasurementTypes: 128,
        CountStyle: 'Circle',
        CountScale: 0.5,
        NumCounts: 1,
        BBMeasure: measureDict(lib, s.feetPerPoint, s.scaleText),
        Vertices: circleVertices(m.points[0]),
      });
      break;
    case 'length':
    case 'segment': {
      const end = m.arrowEnds ? 'ClosedArrow' : 'None';
      Object.assign(dict, {
        AlignOnSegment: true,
        RiseDrop: 0,
        LE: [end, end],
        IT: 'PolyLineDimension',
        MeasurementTypes: 130,
        Measure: measureDict(lib, s.feetPerPoint, s.scaleText),
        Vertices: flat(m.points),
      });
      break;
    }
    case 'area':
      // Fill: Revu reads its color from /IC and its transparency from /FillOpacity
      Object.assign(dict, {
        AlignOnSegment: true,
        IC: rgb(m.areaFillColor),
        FillOpacity: m.fillOpacity,
        IT: 'PolygonDimension',
        MeasurementTypes: 129,
        Measure: measureDict(lib, s.feetPerPoint, s.scaleText),
        Vertices: flat(m.points),
      });
      break;
  }
  return lib.context.obj(dict as Record<string, PDFObject>);
}

// MARK: - Appearance (/AP): how other PDF viewers draw the measurement

function appearance(lib: PDFDocument, font: PDFFont, m: Measurement): { ref: PDFRef; bbox: Rect } {
  const ops: string[] = [];
  const [r, g, b] = rgb(m.lineColor).map(num);
  const path = (pts: Pt[], close: boolean) =>
    pts.map((p, i) => `${num(p.x)} ${num(p.y)} ${i === 0 ? 'm' : 'l'}`).join(' ') +
    (close ? ' h' : '');

  if (m.kind === 'count') {
    ops.push('q /GS0 gs', `${r} ${g} ${b} rg`);
    for (const p of m.points) ops.push(circlePath(p, Measurement.countRadius) + ' f');
    ops.push('Q');
  } else if (m.points.length > 1) {
    if (m.kind === 'area') {
      const [fr, fg, fb] = rgb(m.areaFillColor).map(num);
      ops.push('q /GS1 gs', `${fr} ${fg} ${fb} rg`, path(m.points, true) + ' f', 'Q');
    }
    const dash = dashPattern(m.lineStyle, m.lineWidth).map(num).join(' ');
    ops.push(
      'q /GS0 gs',
      `${r} ${g} ${b} RG`,
      `${num(m.lineWidth)} w 1 J 1 j [${dash}] 0 d`,
      path(m.points, m.kind === 'area') + ' S',
    );
    // Arrowheads (Dimension)
    ops.push(`${r} ${g} ${b} rg`);
    for (const head of m.arrowHeads(m.points, Math.max(m.lineWidth * 6, 6)))
      ops.push(path(head, true) + ' f');
    ops.push('Q');
  }

  // Caption, so other PDF viewers also show the value
  let bbox = m.bounds;
  const anchor = m.captionAnchor;
  if (m.showCaption && m.contents && anchor) {
    const size = m.captionFontSize;
    let text: string | null = null;
    try {
      text = font.encodeText(m.contents).toString();
    } catch {
      text = null;
    }
    if (text) {
      const width = font.widthOfTextAtSize(m.contents, size);
      const gap = m.lineWidth + 2;
      const x = m.kind === 'count' ? anchor.x : anchor.x - width / 2;
      const y =
        m.kind === 'length' || m.kind === 'segment'
          ? anchor.y + gap + size * 0.25
          : anchor.y - size * 0.35;
      const [tr, tg, tb] = rgb(m.captionTextColor).map(num);
      ops.push(
        'q /GS0 gs BT',
        `/Helv ${num(size)} Tf ${tr} ${tg} ${tb} rg ${num(x)} ${num(y)} Td ${text} Tj`,
        'ET Q',
      );
      bbox = union(bbox, { x, y: y - size * 0.3, w: width, h: size * 1.3 });
    }
  }

  const stream = lib.context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h],
    Resources: {
      ExtGState: {
        GS0: { CA: m.opacity, ca: m.opacity },
        GS1: { CA: m.opacity, ca: m.opacity * m.fillOpacity },
      },
      Font: { Helv: font.ref },
    },
  });
  return { ref: lib.context.register(stream), bbox };
}

function circlePath(c: Pt, r: number): string {
  const k = 0.5523 * r;
  return [
    `${num(c.x + r)} ${num(c.y)} m`,
    `${num(c.x + r)} ${num(c.y + k)} ${num(c.x + k)} ${num(c.y + r)} ${num(c.x)} ${num(c.y + r)} c`,
    `${num(c.x - k)} ${num(c.y + r)} ${num(c.x - r)} ${num(c.y + k)} ${num(c.x - r)} ${num(c.y)} c`,
    `${num(c.x - r)} ${num(c.y - k)} ${num(c.x - k)} ${num(c.y - r)} ${num(c.x)} ${num(c.y - r)} c`,
    `${num(c.x + k)} ${num(c.y - r)} ${num(c.x + r)} ${num(c.y - k)} ${num(c.x + r)} ${num(c.y)} c h`,
  ].join(' ');
}

// Revu stores each count as a 24-sided polygon (a circle)
function circleVertices(c: Pt | undefined): number[] {
  if (!c) return [];
  const r = Measurement.countRadius;
  return Array.from({ length: 24 }).flatMap((_, i) => {
    const a = (i / 24) * 2 * Math.PI - Math.PI / 2;
    return [c.x + r * Math.cos(a), c.y + r * Math.sin(a)];
  });
}

// MARK: - Small helpers

function nameOf(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : null;
}
function textOf(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
}
function numberOf(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}
function numbersOf(dict: PDFDict, key: string): number[] | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFArray ? arrayNumbers(v) : null;
}
function arrayNumbers(a: PDFArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = a.lookup(i);
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}
function pairs(n: number[] | null): Pt[] | null {
  if (!n || n.length < 2) return null;
  const out: Pt[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i], y: n[i + 1] });
  return out;
}
function flat(points: Pt[]): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}
// [r, g, b] (0 to 1) → "#RRGGBB"; gray and CMYK are converted too
function colorOf(dict: PDFDict, key: string): string | null {
  const c = numbersOf(dict, key);
  if (!c || c.length === 0) return null;
  let rgbValues: number[];
  if (c.length === 1) rgbValues = [c[0], c[0], c[0]];
  else if (c.length === 4)
    rgbValues = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  else rgbValues = c.slice(0, 3);
  return (
    '#' +
    rgbValues
      .map((v) =>
        Math.round(Math.min(Math.max(v, 0), 1) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}
// "#RRGGBB" → [r, g, b] (0 to 1), the format the PDF uses for /C and /IC
export function rgb(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255 || 0);
}
// PDF numbers can't use exponents (1e-05), so always write plain decimals
function num(v: number): string {
  return Number(v.toFixed(4)).toString();
}
function union(a: Rect, b: Rect): Rect {
  return boundsOf([
    { x: a.x, y: a.y },
    { x: a.x + a.w, y: a.y + a.h },
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
  ]);
}
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '');
}
// Date in PDF format: D:20261113193542-06'00'
function dateText(d: Date): string {
  const p = (v: number) => String(Math.abs(v)).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}` +
    `${p(d.getSeconds())}${sign}${p(Math.trunc(offset / 60))}'${p(offset % 60)}'`
  );
}
