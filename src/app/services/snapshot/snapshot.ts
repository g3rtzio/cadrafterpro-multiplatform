import { Rect } from '../../models/takeoff';
import { DrawingStore, OverlayState, SnapshotClip } from '../drawing.store/drawing.store';
import { PageGeometry, renderRegion } from '../pdf-render/pdf-render';
import { Shape, pageShapes } from '../shapes/shapes';

// Snapshot tool: copies a region of a page as a picture (the drawing plus the markups and
// measurements on top), like Revu's Snapshot. Port has no Mac counterpart.

const SNAPSHOT_DPI = 200;
const MAX_PIXELS = 16_000_000;

// region: view coordinates of the page (PDF points at 100 %, y down)
export async function captureSnapshot(store: DrawingStore, pageIndex: number, g: PageGeometry,
                                      region: Rect): Promise<SnapshotClip | null> {
  let scale = SNAPSHOT_DPI / 72;
  if (region.w * region.h * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (region.w * region.h));
  const canvas = await renderRegion(g, region, scale);
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

// Overlay "Confirm": the page on top as the base page shows it (moved, scaled, rotated, in its color
// and opacity), drawn over a transparent picture the size of the base page.
// White becomes transparent and dark lines take the color, like on screen.
export async function captureOverlay(o: OverlayState, base: PageGeometry, top: PageGeometry):
    Promise<{ url: string; pixels: { width: number; height: number; rgba: Uint8ClampedArray } } | null> {
  const OVERLAY_DPI = 150, OVERLAY_MAX_PIXELS = 12_000_000;
  let k = OVERLAY_DPI / 72;
  if (base.width * base.height * k * k > OVERLAY_MAX_PIXELS) k = Math.sqrt(OVERLAY_MAX_PIXELS / (base.width * base.height));
  // The page on top, sharp enough for its scale on the base page
  const sourceScale = Math.min(k * Math.max(o.scale, 0.1), 6);
  const source = await renderRegion(top, { x: 0, y: 0, w: top.width, h: top.height }, sourceScale);
  if (!source) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(base.width * k));
  canvas.height = Math.max(1, Math.round(base.height * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // Same transform as the plan: translate(dx, dy) rotate scale around the center of the page on top
  ctx.scale(k, k);
  ctx.translate(o.dx + top.width / 2, o.dy + top.height / 2);
  ctx.rotate(o.rotation * Math.PI / 180);
  ctx.scale(o.scale, o.scale);
  ctx.translate(-top.width / 2, -top.height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, top.width, top.height);
  ctx.drawImage(source, 0, 0, top.width, top.height);
  // Tint: every pixel takes the color, alpha = how dark it was × opacity
  const h = o.overlayColor.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const covered = d[i + 3] / 255;
    const luminance = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
    d[i + 3] = Math.round(255 * covered * (1 - luminance) * o.opacity);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(image, 0, 0);
  return { url: canvas.toDataURL('image/png'), pixels: { width: canvas.width, height: canvas.height, rgba: d } };
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
