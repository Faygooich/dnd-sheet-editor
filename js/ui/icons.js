/**
 * Icon sprites from assets/icons/.
 *
 * Act 3 replaced inline emoji with a bundled flat PNG set because emoji
 * render inconsistently across platforms; the same set is reused here, so
 * never put an emoji in the chrome.
 */

const BASE = new URL('../../assets/icons/', import.meta.url);

/** URL for a sprite name, e.g. icon('save') → …/assets/icons/save.png */
export function iconUrl(name) {
  return new URL(`${name}.png`, BASE).href;
}

/** An <img> for a sprite. Unknown names simply render nothing. */
export function iconImg(name, size = 16) {
  const img = document.createElement('img');
  img.src = iconUrl(name);
  img.alt = '';
  img.width = size;
  img.height = size;
  img.draggable = false;
  return img;
}

/** Fill in every <img data-icon="…"> under `root`. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('img[data-icon]')) {
    el.src = iconUrl(el.dataset.icon);
    el.draggable = false;
  }
}
