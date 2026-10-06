/**
 * Entry point. Boots the app shell once the DOM is ready.
 *
 * pdf-lib and fontkit are loaded as classic scripts in index.html, so they
 * are already on globalThis by the time this module runs.
 */

import { App } from './ui/app.js';

async function boot() {
  const app = new App();
  // Handy from the console, and the only global this app defines.
  globalThis.ddsg = app;
  try {
    await app.start();
  } catch (e) {
    console.error('Не удалось запустить приложение:', e);
    const msg = document.getElementById('status-msg');
    if (msg) msg.textContent = `Ошибка запуска: ${e.message}`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
