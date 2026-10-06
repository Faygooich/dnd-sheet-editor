/**
 * Turning stored image/background references into things a browser can load.
 *
 * Act 3 stores absolute filesystem paths, e.g.
 *   D:/Python Projects/Disco&Dragons Sheet Generator Act 3/assets/themes/main_default.pdf
 *   D:/desektop/фото.png
 *
 * A browser has no filesystem, so a reference is resolved in this order:
 *
 *   1. a data: URI                    → used as-is
 *   2. a path containing "assets/"    → the part from "assets/" onward, which
 *                                       is a real URL in this app (this covers
 *                                       every bundled template and static
 *                                       image, including Act 3's absolute
 *                                       paths, since the layout matches)
 *   3. a relative path                → used as-is
 *   4. anything else (a user's own    → unresolvable; callers fall back to an
 *      absolute path on their disk)     empty photo slot or default background
 *
 * This mirrors Act 3's own tolerance: it silently shows an empty slot when a
 * stored path no longer exists.
 */

/** Where the app is served from, so URLs work under a GitHub Pages subpath. */
const BASE = new URL('../../', import.meta.url);

/** Resolve a stored reference to a fetchable URL, or null. */
export function resolveRef(ref) {
  if (!ref) return null;
  const raw = String(ref);
  if (raw.startsWith('data:')) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;

  const norm = raw.replace(/\\/g, '/');

  // Pull out the bundled-asset tail of an absolute path.
  const i = norm.lastIndexOf('assets/');
  if (i >= 0) return new URL(norm.slice(i), BASE).href;

  // A Windows drive letter or a POSIX absolute path we cannot reach.
  if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith('/')) return null;

  return new URL(norm, BASE).href;
}

/** True when a reference will resolve to something loadable. */
export function isResolvable(ref) {
  return resolveRef(ref) !== null;
}

/**
 * Short label for a reference, for status messages.
 * A data: URI has no filename, so it is described rather than printed.
 */
export function refLabel(ref) {
  if (!ref) return '';
  const raw = String(ref);
  if (raw.startsWith('data:')) return 'встроенное изображение';
  const norm = raw.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

const binaryCache = new Map();

/**
 * Fetch a reference as bytes, with a small cache. Throws if unresolvable.
 *
 * The returned ArrayBuffer is SHARED between callers, so anything that might
 * transfer or mutate it must copy first — pdf.js's getDocument() in
 * ui/pdf-render.js is the one place that does.
 */
export async function loadBinary(ref) {
  const url = resolveRef(ref);
  if (!url) throw new Error(`Не удалось найти файл: ${ref}`);

  if (binaryCache.has(url)) return binaryCache.get(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось загрузить ${refLabel(ref)} (${res.status})`);
  const buf = await res.arrayBuffer();
  binaryCache.set(url, buf);
  return buf;
}

/** PNG magic bytes; anything else that decodes is treated as JPEG. */
function sniffImageKind(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  return null;
}

/**
 * Load an image reference as bytes plus its kind, ready for pdf-lib's
 * embedPng / embedJpg.
 *
 * pdf-lib only embeds PNG and JPEG. A BMP, WEBP or TIFF background is
 * re-encoded to PNG through a canvas first, so the formats Act 3's file
 * dialog offers all keep working.
 */
export async function loadImageBytes(ref) {
  const bytes = await loadBinary(ref);
  const kind = sniffImageKind(bytes);
  if (kind) return { bytes, kind };
  return { bytes: await transcodeToPng(bytes), kind: 'png' };
}

/** Re-encode arbitrary image bytes to PNG via an offscreen canvas. */
async function transcodeToPng(bytes) {
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadHtmlImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const out = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось перекодировать изображение'))), 'image/png');
    });
    return await out.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = src;
  });
}

/** Read a File/Blob as a data: URI, which is how images are stored in .ddsg. */
export function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
}
