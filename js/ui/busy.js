/**
 * Full-window busy curtain, replacing Act 3's BusyOverlay / run_busy.
 *
 * Act 3 blocked input with a modal Qt overlay and a hand-drawn spinner arc;
 * here the curtain is a fixed div and the spinner is CSS.
 */

let el = null;
let label = null;
let depth = 0;

function ensure() {
  if (!el) {
    el = document.getElementById('busy');
    label = document.getElementById('busy-label');
  }
  return el;
}

export function showBusy(message = 'Минутку…') {
  const node = ensure();
  if (!node) return;
  depth++;
  label.textContent = message;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add('shown'));
}

export function hideBusy() {
  const node = ensure();
  if (!node) return;
  depth = Math.max(0, depth - 1);
  if (depth > 0) return;
  node.classList.remove('shown');
  const finish = () => { if (depth === 0) node.hidden = true; };
  node.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 260);
}

/**
 * Run `fn` behind the curtain.
 *
 * A frame is yielded first so the curtain actually paints before a long
 * synchronous stretch (PDF export) starts.
 */
export async function runBusy(message, fn) {
  showBusy(message);
  try {
    await new Promise((r) => requestAnimationFrame(() => r()));
    return await fn();
  } finally {
    hideBusy();
  }
}
