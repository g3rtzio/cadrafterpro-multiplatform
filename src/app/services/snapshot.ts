import { Rect } from '../models/takeoff';
import { DrawingStore, SnapshotClip } from './drawing.store';
import { PageGeometry, renderRegion } from './pdf-render';
import { Shape, pageShapes } from './shapes';

// Snapshot tool: copies a region of a page as a picture (the drawing plus the markups and
// measurements on top), like Revu's Snapshot. Port has no Mac counterpart.

const SNAPSHOT_DPI = 200;
const MAX_PIXELS = 16_000_000;

// region: view coordinates of the page (PDF points at 100 %, y down)
export async function captureSnapshot(store: DrawingStore, pageIndex: number, g: PageGeometry,
                                      region: Rect): Promise<SnapshotClip | null> {
  let scale = SNAPSHOT_DPI / 72;
  if (region.w * region.h * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (region.w * region.h));
  const canvas = await renderRegion(g.page, region, scale);
  if (!canvas) return null;

  // Markups and measurements of that page, drawn on top of the picture
  const shapes = pageShapes(store, pageIndex, g, 1, false);
  if (shapes.length) {
    const svg = shapesSvg(shapes, region, canvas.width, canvas.height);
    const image = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)).catch(() => null);
    if (image) canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  const jpegBlob = await toBlob(canvas, 'image/jpeg', 0.92);
  if (!jpegBlob) return null;
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  const url = await blobDataUrl(jpegBlob);

  // Also on the system clipboard, so it can be pasted in other apps (best effort)
  void copyToSystemClipboard(canvas);
  return { url, jpeg, w: region.w, h: region.h };
}

// The SVG layer of the plan as a standalone SVG document, cropped to `region`
function shapesSvg(shapes: Shape[], region: Rect, width: number, height: number): string {
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attr = (name: string, value: unknown) => value === undefined || value === null ? '' : ` ${name}="${esc(value)}"`;
  const body = shapes.map(s => {
    if (s.href) {
      return `<image${attr('href', s.href)}${attr('x', s.x)}${attr('y', s.y)}${attr('width', s.w)}${attr('height', s.h)}`
        + `${attr('opacity', s.opacity)} preserveAspectRatio="none"/>`;
    }
    if (s.text !== undefined) {
      return `<text${attr('x', s.x)}${attr('y', s.y)}${attr('fill', s.fill)}${attr('opacity', s.opacity)}`
        + `${attr('font-size', s.fontSize)}${attr('font-family', s.fontFamily)}${attr('font-weight', s.fontWeight)}`
        + `${attr('font-style', s.fontStyle)}${attr('text-anchor', s.anchor)}${attr('dominant-baseline', s.baseline)}>`
        + `${esc(s.text)}</text>`;
    }
    const blend = s.blend ? ` style="mix-blend-mode:${esc(s.blend)}"` : '';
    return `<path${attr('d', s.d)}${attr('fill', s.fill)}${attr('fill-opacity', s.fillOpacity)}${attr('stroke', s.stroke)}`
      + `${attr('stroke-width', s.width)}${attr('stroke-dasharray', s.dash)}${attr('opacity', s.opacity)}`
      + ` stroke-linecap="round" stroke-linejoin="round"${blend}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
    + ` viewBox="${region.x} ${region.y} ${region.w} ${region.h}" preserveAspectRatio="none">${body}</svg>`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function copyToSystemClipboard(canvas: HTMLCanvasElement): Promise<void> {
  try {
    const png = await toBlob(canvas, 'image/png');
    if (png && navigator.clipboard && 'ClipboardItem' in window) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
  } catch {
    // the browser didn't allow it: the snapshot is still kept in the app
  }
}
