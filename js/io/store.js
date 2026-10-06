/**
 * Browser-local persistence — the counterpart of Act 3's utils/settings.py.
 *
 * There is no server and no shared database: everything below lives in the
 * user's own browser and never leaves the machine.
 *
 *   localStorage  small preferences (autosave on/off)
 *   IndexedDB     the autosaved working sheet, and the recent-sheets list
 *
 * A sheet with inlined photos easily exceeds localStorage's ~5 MB, hence
 * IndexedDB. Recent entries hold the sheet payload itself rather than a path,
 * because a browser cannot reopen a path it was handed earlier.
 */

const DB_NAME = 'disco-dragons';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_RECENT = 'recent';

const PREF_AUTOSAVE = 'dd.autosave.enabled';

/** Act 3 caps the recent list at 10, most-recent-first. */
const RECENT_MAX = 10;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB недоступен'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
        if (!db.objectStoreNames.contains(STORE_RECENT)) {
          db.createObjectStore(STORE_RECENT, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      // Private windows and blocked site data both land here; the app must
      // keep working without any persistence at all.
      console.warn('Локальное хранилище недоступно:', e);
      return null;
    });
  }
  return dbPromise;
}

/** Sentinel telling callers the browser gave us no storage at all. */
export const NO_STORAGE = Symbol('no-storage');

async function tx(storeName, mode, fn) {
  const db = await openDb();
  if (!db) return NO_STORAGE;
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }).catch((e) => {
    console.warn('Ошибка локального хранилища:', e);
    return NO_STORAGE;
  });
}

// ── preferences ─────────────────────────────────────────────────────────────

export function autosaveEnabled() {
  try {
    const v = localStorage.getItem(PREF_AUTOSAVE);
    return v === null ? true : v === '1';       // default on, as in Act 3
  } catch (e) {
    return true;
  }
}

export function setAutosaveEnabled(on) {
  try {
    localStorage.setItem(PREF_AUTOSAVE, on ? '1' : '0');
  } catch (e) { /* storage blocked; the setting just will not stick */ }
}

// ── autosaved working sheet ─────────────────────────────────────────────────

/**
 * @param {{title:string, fileName:string|null, json:object}} snapshot
 * @returns {Promise<boolean>} false when the browser has no usable storage,
 *   so callers never claim a save that did not happen.
 */
export async function saveWorkingSheet(snapshot) {
  const r = await tx(STORE_STATE, 'readwrite', (s) => s.put({
    ...snapshot,
    savedAt: Date.now(),
  }, 'working'));
  return r !== NO_STORAGE;
}

export async function loadWorkingSheet() {
  const r = await tx(STORE_STATE, 'readonly', (s) => s.get('working'));
  return r === NO_STORAGE ? null : r;
}

export async function clearWorkingSheet() {
  await tx(STORE_STATE, 'readwrite', (s) => s.delete('working'));
}

// ── recent sheets ───────────────────────────────────────────────────────────

/** Newest first. */
export async function recentSheets() {
  const all = await tx(STORE_RECENT, 'readonly', (s) => s.getAll());
  if (all === NO_STORAGE || !Array.isArray(all)) return [];
  return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

/**
 * Record a sheet in the recent list, de-duplicated by title + file name and
 * trimmed to RECENT_MAX.
 */
export async function pushRecent({ title, fileName, json }) {
  const id = `${fileName || ''}|${title || ''}`;
  const existing = await recentSheets();

  await tx(STORE_RECENT, 'readwrite', (s) => {
    s.put({ id, title, fileName, json, openedAt: Date.now() });
    // Drop the oldest beyond the cap, ignoring the one just written.
    const keep = existing.filter((r) => r.id !== id).slice(0, RECENT_MAX - 1);
    const kept = new Set(keep.map((r) => r.id));
    for (const r of existing) {
      if (r.id !== id && !kept.has(r.id)) s.delete(r.id);
    }
  });
}

export async function clearRecent() {
  await tx(STORE_RECENT, 'readwrite', (s) => s.clear());
}

export { RECENT_MAX };
