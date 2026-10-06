/**
 * Opening and saving files.
 *
 * Where the File System Access API exists (Chrome, Edge) a real file handle
 * is kept, so «Сохранить» overwrites the same file the way the desktop app
 * does. Elsewhere (Firefox, Safari) it degrades to an <input type="file"> for
 * opening and a download for saving, and «Сохранить» behaves like
 * «Сохранить как…» because a browser cannot write back silently.
 */

export const hasFsAccess = typeof globalThis.showSaveFilePicker === 'function';

const DDSG_TYPE = {
  description: 'DDSG — Disco & Dragons',
  accept: { 'application/json': ['.ddsg'] },
};
const LSS_TYPE = {
  description: 'LSS json — Long Story Short',
  accept: { 'application/json': ['.json'] },
};
const PDF_TYPE = {
  description: 'PDF',
  accept: { 'application/pdf': ['.pdf'] },
};
const SHEET_TYPES = [
  { description: 'Все анкеты', accept: { 'application/json': ['.ddsg', '.json'] } },
  DDSG_TYPE,
  LSS_TYPE,
];
const IMAGE_TYPES = [{
  description: 'Изображения',
  accept: {
    'application/pdf': ['.pdf'],
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/bmp': ['.bmp'],
    'image/webp': ['.webp'],
  },
}];

/**
 * Ask the user for a sheet file.
 * @returns {Promise<{name:string, text:string, handle:any}|null>}
 */
export async function openSheetFile() {
  if (typeof globalThis.showOpenFilePicker === 'function') {
    let handles;
    try {
      handles = await globalThis.showOpenFilePicker({ types: SHEET_TYPES, multiple: false });
    } catch (e) {
      return null;                                  // user cancelled
    }
    const handle = handles[0];
    const file = await handle.getFile();
    return { name: file.name, text: await file.text(), handle };
  }

  const file = await pickFile('.ddsg,.json,application/json');
  if (!file) return null;
  return { name: file.name, text: await file.text(), handle: null };
}

/** Ask for a background image or PDF. */
export async function openBackgroundFile() {
  if (typeof globalThis.showOpenFilePicker === 'function') {
    try {
      const [handle] = await globalThis.showOpenFilePicker({
        types: IMAGE_TYPES, multiple: false,
      });
      return await handle.getFile();
    } catch (e) {
      return null;
    }
  }
  return pickFile('.pdf,.png,.jpg,.jpeg,.bmp,.webp');
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.addEventListener('change', () => resolve(inp.files && inp.files[0]));
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

/**
 * Save-as for a sheet. `kind` is "ddsg" or "lss" and picks the file filter.
 * @returns {Promise<{name:string, handle:any}|null>}
 */
export async function saveSheetAs(suggestedName, bytesOrText, kind = 'ddsg') {
  const types = kind === 'lss' ? [LSS_TYPE, DDSG_TYPE] : [DDSG_TYPE, LSS_TYPE];
  if (hasFsAccess) {
    let handle;
    try {
      handle = await globalThis.showSaveFilePicker({ suggestedName, types });
    } catch (e) {
      return null;
    }
    await writeHandle(handle, bytesOrText);
    return { name: handle.name, handle };
  }
  downloadBlob(suggestedName, bytesOrText, 'application/json');
  return { name: suggestedName, handle: null };
}

/** Overwrite a file we already have a handle for. */
export async function writeHandle(handle, bytesOrText) {
  const writable = await handle.createWritable();
  await writable.write(bytesOrText);
  await writable.close();
}

/** Save a generated PDF. */
export async function savePdf(suggestedName, bytes) {
  if (hasFsAccess) {
    let handle;
    try {
      handle = await globalThis.showSaveFilePicker({ suggestedName, types: [PDF_TYPE] });
    } catch (e) {
      return null;
    }
    await writeHandle(handle, bytes);
    return { name: handle.name };
  }
  downloadBlob(suggestedName, bytes, 'application/pdf');
  return { name: suggestedName };
}

/** Fallback save: hand the file to the browser's downloader. */
export function downloadBlob(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke late; Safari needs the URL to still be alive when the click lands.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Re-check permission on a stored handle. Handles survive in IndexedDB, but
 * the grant does not survive a reload, so this must be called before reuse.
 */
export async function ensureWritePermission(handle) {
  if (!handle || !handle.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
