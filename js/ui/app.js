/**
 * The application shell — Act 3's ui/main_window.MainWindow.
 *
 * Owns one SheetModel, the menus, the page bar, the status bar and the file
 * operations. Developer mode is deliberately absent from the web build: the
 * password would be readable in the shipped JavaScript, and the field-layout
 * editor stays in the desktop app. Whatever `fields` a sheet carries are
 * still loaded, rendered and saved back untouched.
 */

import {
  SheetModel, PAGE_KIND_MAIN, PAGE_KIND_LONGPLAY, PAGE_KIND_NOTE_TEMPLATE,
} from '../core/sheet-model.js';
import { SheetCanvas } from './sheet-canvas.js';
import { HiddenPanel } from './hidden-panel.js';
import { iconImg, hydrateIcons } from './icons.js';
import * as dlg from './dialogs.js';
import { runBusy } from './busy.js';
import { exportSheetToPdf } from '../export/pdf-export.js';
import { detectFormat, parseSheetText, FORMAT_LABELS } from '../io/detect-format.js';
import * as fileIo from '../io/file-io.js';
import * as store from '../io/store.js';
import { fileToDataUri } from '../io/asset-paths.js';

const TEMPLATE_URL = new URL('../../assets/themes/default.json', import.meta.url);

const KIND_LABELS = {
  [PAGE_KIND_MAIN]: 'Основная',
  [PAGE_KIND_LONGPLAY]: 'Лонгплей',
  [PAGE_KIND_NOTE_TEMPLATE]: 'Шаблон заметки',
};

/** Act 3 debounces its autosave by 1500 ms after the last change. */
const AUTOSAVE_DELAY = 1500;
const STATUS_RESET_DELAY = 5000;

export class App {
  constructor() {
    this.sheet = new SheetModel();
    this.viewKind = PAGE_KIND_MAIN;
    this.viewNoteId = null;
    this.fileName = null;
    this.fileHandle = null;
    this.dirty = false;

    this.els = {
      menubar: document.getElementById('menubar'),
      pagebar: document.getElementById('pagebar'),
      indicator: document.getElementById('page-indicator'),
      statusMsg: document.getElementById('status-msg'),
      fieldCount: document.getElementById('field-count'),
      modeStatus: document.getElementById('mode-status'),
      zoomLevel: document.getElementById('zoom-level'),
      recentPopup: document.getElementById('recent-popup'),
      dropHint: document.getElementById('drop-hint'),
      canvasView: document.getElementById('canvas-view'),
      noteView: document.getElementById('note-view'),
    };

    this.canvas = new SheetCanvas(this.els.canvasView, {
      onValueChanged: () => {
        this.markDirty();
        this.hiddenPanel.refreshValues();
      },
    });
    this.hiddenPanel = new HiddenPanel(document.getElementById('hidden-panel'), {
      onValueChanged: () => {
        this.markDirty();
        this.canvas.scheduleRecompute();
      },
    });

    this._statusTimer = 0;
    this._autosaveTimer = 0;
  }

  // ── startup ────────────────────────────────────────────────────────────

  async start() {
    hydrateIcons();
    this._wireMenus();
    this._wireShortcuts();
    this._wireZoom();
    this._wireDropTarget();
    this._wireUnloadGuard();

    this.els.modeStatus.textContent = '[ Заполнение ]';

    const restored = await this._restoreAutosave();
    if (!restored) {
      this.sheet = await this._freshDefaultTemplate();
      this._afterSheetLoaded();
      this.setStatus('Готово');
    }

    // Fit once the first background has had a chance to lay out.
    requestAnimationFrame(() => this.canvas.zoomFit());
  }

  /** Restore the autosaved working sheet, if there is one. */
  async _restoreAutosave() {
    if (!store.autosaveEnabled()) return false;
    const snap = await store.loadWorkingSheet();
    if (!snap || !snap.json) return false;
    try {
      this.sheet = SheetModel.fromJSON(snap.json);
      this.fileName = snap.fileName || null;
      this._afterSheetLoaded();
      this.dirty = Boolean(snap.dirty);
      this._updateTitle();
      this.setStatus(`Восстановлена анкета «${this.sheet.title}»`);
      return true;
    } catch (e) {
      console.warn('Не удалось восстановить автосохранение:', e);
      return false;
    }
  }

  /**
   * The bundled field layout, used for new sheets and as the donor layout
   * when importing a foreign format that carries values but no geometry.
   */
  async _freshDefaultTemplate() {
    try {
      const res = await fetch(TEMPLATE_URL);
      if (!res.ok) throw new Error(String(res.status));
      return SheetModel.parse(await res.text());
    } catch (e) {
      console.warn('Стандартный шаблон не загружен:', e);
      return new SheetModel();
    }
  }

  _afterSheetLoaded() {
    this.canvas.setSheet(this.sheet);
    this.hiddenPanel.setSheet(this.sheet);
    this.viewKind = PAGE_KIND_MAIN;
    this.viewNoteId = null;
    this.canvas.setViewTarget(PAGE_KIND_MAIN, null);
    this.rebuildPageBar();
    this._updateFieldCount();
    this._updateTitle();
  }

  // ── status / title ─────────────────────────────────────────────────────

  setStatus(msg) {
    const el = this.els.statusMsg;
    el.classList.add('flash');
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.remove('flash'));
    clearTimeout(this._statusTimer);
    if (msg !== 'Готово') {
      this._statusTimer = setTimeout(() => { el.textContent = 'Готово'; }, STATUS_RESET_DELAY);
    }
  }

  _updateFieldCount() {
    this.els.fieldCount.textContent = `Полей: ${this.sheet.fields.length}`;
  }

  _updateTitle() {
    document.title = `${this.sheet.title}${this.dirty ? ' *' : ''} — Disco & Dragons`;
  }

  markDirty() {
    this.dirty = true;
    this._updateTitle();
    this._scheduleAutosave();
  }

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    if (!store.autosaveEnabled()) return;
    this._autosaveTimer = setTimeout(async () => {
      try {
        const saved = await store.saveWorkingSheet({
          title: this.sheet.title,
          fileName: this.fileName,
          dirty: this.dirty,
          json: this.sheet.toJSON(),
        });
        // Private windows and blocked site data leave us with no storage;
        // say so rather than claiming a save that never happened.
        this.setStatus(saved
          ? `Автосохранение в браузере: ${this.sheet.title}`
          : 'Автосохранение недоступно: браузер не даёт локальное хранилище');
      } catch (e) {
        this.setStatus(`Автосохранение не удалось: ${e.message}`);
      }
    }, AUTOSAVE_DELAY);
  }

  // ── menus ──────────────────────────────────────────────────────────────

  _wireMenus() {
    const closeAll = () => {
      for (const m of this.els.menubar.querySelectorAll('.menu.open, .submenu.open')) {
        m.classList.remove('open');
        m.querySelector(':scope > button')?.setAttribute('aria-expanded', 'false');
      }
    };

    for (const menu of this.els.menubar.querySelectorAll(':scope > .menu')) {
      const btn = menu.querySelector(':scope > button');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = menu.classList.contains('open');
        closeAll();
        if (!wasOpen) {
          menu.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
          if (menu.dataset.menu === 'file') this._rebuildRecentMenu();
        }
      });
      // Hovering a sibling while one is open moves the open menu, like a menubar.
      btn.addEventListener('mouseenter', () => {
        if (this.els.menubar.querySelector('.menu.open') && !menu.classList.contains('open')) {
          closeAll();
          menu.classList.add('open');
          if (menu.dataset.menu === 'file') this._rebuildRecentMenu();
        }
      });
    }

    for (const sub of this.els.menubar.querySelectorAll('.submenu')) {
      sub.addEventListener('mouseenter', () => sub.classList.add('open'));
      sub.addEventListener('mouseleave', () => sub.classList.remove('open'));
    }

    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

    this.els.menubar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      closeAll();
      this.runAction(btn.dataset.act);
    });
  }

  async _rebuildRecentMenu() {
    const popup = this.els.recentPopup;
    popup.textContent = '';
    const recent = await store.recentSheets();

    if (!recent.length) {
      const empty = document.createElement('button');
      empty.type = 'button';
      empty.disabled = true;
      empty.textContent = '(пусто)';
      popup.append(empty);
      return;
    }

    recent.forEach((entry, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${i + 1}. ${entry.fileName || entry.title}`;
      b.title = entry.title;
      b.addEventListener('click', () => this._openRecent(entry));
      popup.append(b);
    });

    popup.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Очистить список';
    clear.addEventListener('click', async () => {
      await store.clearRecent();
      this.setStatus('Список недавних файлов очищен');
    });
    popup.append(clear);
  }

  async _openRecent(entry) {
    if (!(await this._confirmDiscard())) return;
    try {
      this.sheet = SheetModel.fromJSON(entry.json);
      this.fileName = entry.fileName || null;
      this.fileHandle = null;
      this.dirty = false;
      this._afterSheetLoaded();
      this.canvas.zoomFit();
      this.setStatus(`Открыто: ${entry.fileName || entry.title}`);
    } catch (e) {
      dlg.error('Ошибка', `Не удалось открыть анкету:\n${e.message}`);
    }
  }

  // ── actions ────────────────────────────────────────────────────────────

  async runAction(act) {
    switch (act) {
      case 'new': return this.newSheet();
      case 'open': return this.openSheet();
      case 'save': return this.saveSheet();
      case 'save-as': return this.saveSheetAs();
      case 'export-pdf': return this.exportPdf();
      case 'change-bg': return this.changeBackground();
      case 'reset-bg': return this.resetBackground();
      case 'settings': return this.openSettings();
      case 'rename': return this.renameSheet();
      case 'about': return dlg.about();
      case 'zoom-in': return this.canvas.zoomIn();
      case 'zoom-out': return this.canvas.zoomOut();
      case 'zoom-fit': return this.canvas.zoomFit();
      default: return undefined;
    }
  }

  async _confirmDiscard() {
    if (!this.dirty) return true;
    return dlg.confirm(
      'Несохранённые изменения',
      'Есть несохранённые изменения. Продолжить без сохранения?',
    );
  }

  async newSheet() {
    if (!(await this._confirmDiscard())) return;
    const title = await dlg.prompt('Новая анкета', 'Название анкеты:', {
      value: 'Новая Анкета',
    });
    if (title === null) return;

    const model = await this._freshDefaultTemplate();
    model.title = title || 'Новая Анкета';
    // A fresh sheet keeps the layout but none of the template's sample values.
    model.clearValues();
    model.note_instances = [];

    this.sheet = model;
    this.fileName = null;
    this.fileHandle = null;
    this.dirty = false;
    this._afterSheetLoaded();
    this.canvas.zoomFit();
    this.setStatus(`Создана анкета «${this.sheet.title}»`);
  }

  async openSheet() {
    if (!(await this._confirmDiscard())) return;
    const picked = await fileIo.openSheetFile();
    if (!picked) return;
    await this.loadSheetText(picked.text, picked.name, picked.handle);
  }

  /**
   * Load sheet text of any supported format.
   *
   * An imported (non-native) sheet clears the file handle and starts dirty,
   * so the user is pushed through «Сохранить как…» to choose a native
   * destination — Act 2 in particular must never be written back.
   */
  async loadSheetText(text, name, handle = null) {
    let obj;
    try {
      obj = parseSheetText(text);
    } catch (e) {
      dlg.error('Ошибка', `Не удалось прочитать файл:\n${e.message}`);
      return;
    }

    const fmt = detectFormat(obj);
    if (fmt === 'unknown') {
      dlg.error('Ошибка', 'Не удалось распознать формат файла.\n'
        + 'Поддерживаются .ddsg, LSS json и старый формат DDSG Act 2.');
      return;
    }
    if (fmt === 'lss' || fmt === 'act2') {
      dlg.info('Пока недоступно',
        `Это ${FORMAT_LABELS[fmt]}. Импорт этого формата появится на следующем этапе — `
        + 'пока открывайте такие анкеты в десктопной версии Act 3 и сохраняйте в .ddsg.');
      return;
    }

    try {
      this.sheet = SheetModel.fromJSON(obj);
    } catch (e) {
      dlg.error('Ошибка', `Не удалось открыть анкету:\n${e.message}`);
      return;
    }

    this.fileName = name || this.sheet.defaultSaveName();
    this.fileHandle = handle;
    this.dirty = false;
    this._afterSheetLoaded();
    this.canvas.zoomFit();

    await store.pushRecent({
      title: this.sheet.title,
      fileName: this.fileName,
      json: this.sheet.toJSON(),
    });

    const notes = this.sheet.note_instances.length;
    this.setStatus(notes
      ? `Открыто: ${this.fileName} (страниц заметок: ${notes} — редактор заметок будет на следующем этапе)`
      : `Открыто: ${this.fileName}`);
  }

  async saveSheet() {
    // Without the File System Access API there is no silent overwrite.
    if (this.fileHandle && await fileIo.ensureWritePermission(this.fileHandle)) {
      try {
        await fileIo.writeHandle(this.fileHandle, this.sheet.serialize());
        this.dirty = false;
        this._updateTitle();
        this.setStatus(`Сохранено: ${this.fileName}`);
        return;
      } catch (e) {
        dlg.error('Ошибка', `Не удалось сохранить:\n${e.message}`);
        return;
      }
    }
    return this.saveSheetAs();
  }

  async saveSheetAs() {
    const name = this.sheet.defaultSaveName();
    let res;
    try {
      res = await fileIo.saveSheetAs(name, this.sheet.serialize(), 'ddsg');
    } catch (e) {
      dlg.error('Ошибка', `Не удалось сохранить:\n${e.message}`);
      return;
    }
    if (!res) return;

    this.fileName = res.name;
    this.fileHandle = res.handle;
    this.dirty = false;
    this._updateTitle();
    await store.pushRecent({
      title: this.sheet.title,
      fileName: this.fileName,
      json: this.sheet.toJSON(),
    });
    this.setStatus(`Сохранено: ${this.fileName}`);
  }

  async exportPdf() {
    const name = this.sheet.generateFilename('pdf');
    try {
      const bytes = await runBusy('Создаём PDF…', () => exportSheetToPdf(this.sheet));
      const res = await fileIo.savePdf(name, bytes);
      if (!res) return;
      this.setStatus(`PDF сохранён: ${res.name}`);
      await dlg.info('Готово', `PDF успешно сохранён:\n${res.name}`);
    } catch (e) {
      console.error(e);
      this.setStatus('Ошибка экспорта');
      dlg.error('Ошибка экспорта', `Не удалось создать PDF:\n${e.message}`);
    }
  }

  async changeBackground() {
    const file = await fileIo.openBackgroundFile();
    if (!file) return;
    // A browser cannot keep a path, so the picture is inlined into the sheet.
    const dataUri = await fileToDataUri(file);
    this.sheet.setBackgroundForKind(this.viewKind, dataUri);
    this.canvas.loadBackground();
    this.markDirty();
    this.setStatus(`Фон (${KIND_LABELS[this.viewKind]}) изменён: ${file.name}`);
  }

  resetBackground() {
    this.sheet.resetBackgroundToDefault(this.viewKind);
    this.canvas.loadBackground();
    this.markDirty();
    this.setStatus(`Фон (${KIND_LABELS[this.viewKind]}) сброшен к стандартному`);
  }

  async renameSheet() {
    const title = await dlg.prompt('Переименование', 'Название анкеты:', {
      value: this.sheet.title,
    });
    if (title === null) return;
    this.sheet.title = title || this.sheet.title;
    this.markDirty();
    this.setStatus(`Анкета переименована: ${this.sheet.title}`);
  }

  async openSettings() {
    const res = await dlg.settings({
      autosave: store.autosaveEnabled(),
      onClearRecent: () => store.clearRecent(),
    });
    if (!res) return;
    store.setAutosaveEnabled(res.autosave);
    if (!res.autosave) await store.clearWorkingSheet();
    this.setStatus(`Автосохранение: ${res.autosave ? 'включено' : 'отключено'}`);
  }

  // ── page bar ───────────────────────────────────────────────────────────

  /**
   * Rebuild the page strip.
   *
   * Phase 1 shows the two field pages. Note pages live in the model and
   * round-trip through save and export untouched, but they get their own
   * controls once the note editor lands.
   */
  rebuildPageBar() {
    const bar = this.els.pagebar;
    for (const el of [...bar.children]) {
      if (el.id !== 'page-indicator') el.remove();
    }

    const mainBtn = this._makeKindButton(PAGE_KIND_MAIN, 'Основная', 'page_main');
    bar.append(mainBtn);

    const lpBtn = this._makeKindButton(PAGE_KIND_LONGPLAY, 'Лонгплей', 'page_longplay');
    if (!this.sheet.longplay_enabled) lpBtn.classList.add('dimmed');
    bar.append(lpBtn);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'page-mini';
    toggle.append(iconImg(this.sheet.longplay_enabled ? 'printer' : 'cross', 13));
    toggle.title = this.sheet.longplay_enabled
      ? 'Отключить лонгплей в PDF (страница не попадёт в экспорт)'
      : 'Включить лонгплей в PDF';
    toggle.addEventListener('click', () => this._toggleLongplay());
    bar.append(toggle);

    const spacer = document.createElement('div');
    spacer.className = 'page-spacer';
    bar.append(spacer);

    if (this.sheet.note_instances.length) {
      const note = document.createElement('span');
      note.className = 'hint';
      note.style.paddingRight = '8px';
      const n = this.sheet.note_instances.length;
      note.textContent = `страниц заметок: ${n}`;
      note.title = 'Заметки сохраняются и экспортируются без изменений; '
        + 'их редактор появится на следующем этапе.';
      bar.append(note);
    }

    this._moveIndicator();
  }

  _makeKindButton(kind, label, icon) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-btn';
    b.dataset.kind = kind;
    b.append(iconImg(icon, 14), document.createTextNode(label));
    if (this.viewKind === kind && !this.viewNoteId) b.classList.add('active');
    b.addEventListener('click', () => this.switchView(kind));
    return b;
  }

  _toggleLongplay() {
    this.sheet.longplay_enabled = !this.sheet.longplay_enabled;
    this.markDirty();
    // Leaving a page that is now excluded would be confusing; stay put but
    // make the state visible.
    this.setStatus(this.sheet.longplay_enabled
      ? 'Лонгплей-страница в PDF: включена'
      : 'Лонгплей-страница в PDF: исключена');
    this.rebuildPageBar();
  }

  switchView(kind, noteId = null) {
    if (kind === this.viewKind && noteId === this.viewNoteId) return;
    this.viewKind = kind;
    this.viewNoteId = noteId;
    this.canvas.setViewTarget(kind, noteId);
    this.rebuildPageBar();
  }

  _moveIndicator() {
    const active = this.els.pagebar.querySelector('.page-btn.active');
    const ind = this.els.indicator;
    if (!active) { ind.classList.remove('visible'); return; }
    const barRect = this.els.pagebar.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    ind.style.width = `${r.width}px`;
    ind.style.transform = `translateX(${r.left - barRect.left + this.els.pagebar.scrollLeft}px)`;
    ind.classList.add('visible');
  }

  // ── zoom, shortcuts, drop, unload ──────────────────────────────────────

  _wireZoom() {
    this.els.canvasView.addEventListener('zoomchange', (e) => {
      this.els.zoomLevel.textContent = `${Math.round(e.detail.zoom * 100)}%`;
    });
    document.getElementById('zoom-bar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) this.runAction(btn.dataset.act);
    });
  }

  _wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (e.shiftKey) this.saveSheetAs(); else this.saveSheet();
      } else if (k === 'o') {
        e.preventDefault();
        this.openSheet();
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        this.canvas.zoomIn();
      } else if (k === '-') {
        e.preventDefault();
        this.canvas.zoomOut();
      } else if (k === '0') {
        e.preventDefault();
        this.canvas.zoomFit();
      }
    });
  }

  _wireDropTarget() {
    let depth = 0;
    const hint = this.els.dropHint;

    window.addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      depth++;
      hint.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) hint.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      hint.hidden = true;
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!(await this._confirmDiscard())) return;
      await this.loadSheetText(await file.text(), file.name, null);
    });
  }

  _wireUnloadGuard() {
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }
}
