/**
 * Rendering a background into a canvas with pdf.js — the preview counterpart
 * of Act 3's `load_background_pixmap`.
 *
 * Act 3 rasterised the PDF once at ~192 DPI and let Qt scale the pixmap.
 * Here the canvas is re-rendered for the current zoom (capped, and debounced
 * by the caller) so the background stays crisp when zoomed in, instead of
 * blurring like an upscaled bitmap.
 */

import { A4_W, A4_H } from '../core/sheet-model.js';
import { loadBinary, resolveRef } from '../io/asset-paths.js';

const WORKER_URL = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

/** Beyond this the canvas gets large enough to cost more than it gains. */
const MAX_SCALE = 4;

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.min.mjs').then((mod) => {
      const lib = mod.default && mod.default.getDocument ? mod.default : mod;
      lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

const docCache = new Map();

async function loadPdfPage(ref) {
  const url = resolveRef(ref);
  if (!url) throw new Error(`Фон недоступен: ${ref}`);

  let page = docCache.get(url);
  if (!page) {
    const pdfjs = await getPdfjs();
    // getDocument() TRANSFERS the buffer to the pdf.js worker, which detaches
    // it in this thread. loadBinary() hands back a shared cached buffer that
    // the PDF exporter also reads, so hand pdf.js its own copy — otherwise
    // previewing a background silently breaks the next export of it.
    const src = await loadBinary(ref);
    const bytes = new Uint8Array(src.byteLength);
    bytes.set(new Uint8Array(src));
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    page = await doc.getPage(1);
    docCache.set(url, page);
  }
  return page;
}

const RASTER_RE = /\.(png|jpe?g|bmp|webp|tiff?|gif)$/i;

/** True when the reference is an image rather than a PDF. */
export function isRasterBackground(ref) {
  if (!ref) return false;
  if (ref.startsWith('data:')) return !ref.startsWith('data:application/pdf');
  return RASTER_RE.test(ref);
}

/**
 * Draw a PDF background's first page into `canvas`, sized for `zoom`.
 *
 * The canvas keeps its CSS size from the stylesheet (100% of the page box);
 * only the backing-store resolution changes, so the picture sharpens without
 * shifting anything.
 */
export async function renderPdfBackground(canvas, ref, zoom = 1) {
  const page = await loadPdfPage(ref);

  const dpr = globalThis.devicePixelRatio || 1;
  const scale = Math.min(MAX_SCALE, Math.max(1, zoom * dpr));

  // The template pages are A4, but respect whatever the file actually says.
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(A4_W / base.width, A4_H / base.height) || 1;
  const viewport = page.getViewport({ scale: fit * scale });

  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  await page.render({ canvasContext: ctx, viewport }).promise;
  return { width: w, height: h };
}

/** Paint a flat white page, used when a background cannot be resolved. */
export function renderBlankBackground(canvas) {
  canvas.width = Math.round(A4_W);
  canvas.height = Math.round(A4_H);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
