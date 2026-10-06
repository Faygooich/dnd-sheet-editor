/**
 * The A4 sheet view — Act 3's ui/canvas_widget.SheetCanvas, fill mode only.
 *
 * The page div is exactly A4_W x A4_H CSS px, so field geometry goes straight
 * from the model onto `style.left/top/width/height` with no transform maths.
 * Zoom is a CSS scale on that div; the wrapper is resized to match so the
 * scrollbars stay honest.
 */

import { A4_W, A4_H } from '../core/sheet-model.js';
import { createFieldWidget } from './field-widgets.js';
import { renderPdfBackground, renderBlankBackground, isRasterBackground } from './pdf-render.js';
import { resolveRef } from '../io/asset-paths.js';

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 1.15;      // menu buttons
const WHEEL_STEP = 1.12;     // one wheel notch
const FIT_MARGIN = 20;       // points of breathing room around the page
const STAGE_PAD = 20;        // #stage padding, mirrored from canvas.css

/** Formula recompute is debounced by the same 80 ms Act 3 uses. */
const RECOMPUTE_DELAY = 80;

export class SheetCanvas {
  constructor(root, { onValueChanged } = {}) {
    this.root = root;                                  // #canvas-view
    this.stage = root.querySelector('#stage');
    this.page = root.querySelector('#page');
    this.bgCanvas = root.querySelector('#page-bg');
    this.bgImg = root.querySelector('#page-bg-img');
    this.layer = root.querySelector('#field-layer');

    this.sheet = null;
    this.viewKind = 'main';
    this.noteId = null;
    this.zoom = 1;
    this.widgets = new Map();                          // field.id → widget
    this.onValueChanged = onValueChanged || (() => {});

    this._recomputeTimer = 0;
    this._bgTimer = 0;
    this._bgRef = null;
    this._bgZoom = 0;

    this.root.addEventListener('wheel', this._onWheel, { passive: false });
    this._onResize = () => this._applyZoom();
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    this.root.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
  }

  setSheet(sheet) {
    this.sheet = sheet;
  }

  /** Point the canvas at a page kind and rebuild everything on it. */
  setViewTarget(kind, noteId = null) {
    this.viewKind = kind;
    this.noteId = noteId;
    this.rebuild();
    this.loadBackground();
  }

  // ── value plumbing ─────────────────────────────────────────────────────

  _ctx() {
    const sheet = this.sheet;
    const noteId = this.viewKind === 'note_template' ? this.noteId : null;
    return {
      getValue: (name) => (noteId
        ? sheet.getNoteRawValue(noteId, name)
        : sheet.getRawValue(name)),
      setValue: (name, value) => {
        if (noteId) sheet.setNoteValue(noteId, name, value);
        else sheet.setValue(name, value);
        this.scheduleRecompute();
        this.onValueChanged(name, value);
      },
    };
  }

  /** Debounced formula pass, so typing stays smooth but feels live. */
  scheduleRecompute() {
    clearTimeout(this._recomputeTimer);
    this._recomputeTimer = setTimeout(() => this.refreshFormulaValues(), RECOMPUTE_DELAY);
  }

  /**
   * Push recomputed values into every non-editable widget, plus the hidden
   * and stats widgets whose display depends on other fields.
   */
  refreshFormulaValues() {
    if (!this.sheet) return;
    const values = this.viewKind === 'note_template' && this.noteId
      ? this.sheet.evaluateAllFormulasForNote(this.noteId)
      : this.sheet.evaluateAllFormulas();

    for (const [id, w] of this.widgets) {
      const field = this.sheet.getField(id);
      if (!field) continue;
      if (field.field_type === 'formula' && w.setDisplay) {
        w.setDisplay(values[field.name] || '');
      } else if (w.refresh) {
        w.refresh();
      }
    }
    return values;
  }

  // ── building ───────────────────────────────────────────────────────────

  rebuild() {
    this.layer.textContent = '';
    this.widgets.clear();
    if (!this.sheet) return;

    const ctx = this._ctx();
    // List order is z-order, so appending in order is enough.
    for (const field of this.sheet.fieldsForKind(this.viewKind)) {
      const widget = createFieldWidget(field, ctx);
      this.layer.append(widget.el);
      this.widgets.set(field.id, widget);
    }
    this.refreshFormulaValues();
  }

  // ── background ─────────────────────────────────────────────────────────

  loadBackground() {
    if (!this.sheet) return;
    const ref = this.sheet.backgroundForKind(this.viewKind);
    this._bgRef = ref;
    this._bgZoom = 0;

    if (isRasterBackground(ref)) {
      const url = resolveRef(ref);
      this.bgCanvas.hidden = true;
      if (url) {
        this.bgImg.src = url;
        this.bgImg.hidden = false;
      } else {
        this.bgImg.hidden = true;
        this.bgCanvas.hidden = false;
        renderBlankBackground(this.bgCanvas);
      }
      return;
    }

    this.bgImg.hidden = true;
    this.bgCanvas.hidden = false;
    this._renderPdfBg();
  }

  async _renderPdfBg() {
    const ref = this._bgRef;
    if (!ref) return;
    // Re-rasterise at the current zoom so zooming in sharpens the template.
    const target = Math.min(4, Math.max(1, this.zoom));
    if (this._bgZoom === target) return;
    try {
      await renderPdfBackground(this.bgCanvas, ref, target);
      if (this._bgRef === ref) this._bgZoom = target;
    } catch (e) {
      console.warn('Фон не отрисован:', e);
      renderBlankBackground(this.bgCanvas);
    }
  }

  _scheduleBgRerender() {
    clearTimeout(this._bgTimer);
    this._bgTimer = setTimeout(() => {
      if (!isRasterBackground(this._bgRef)) this._renderPdfBg();
    }, 180);
  }

  // ── zoom ───────────────────────────────────────────────────────────────

  setZoom(z, anchor = null) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (Math.abs(next - this.zoom) < 1e-4) return;

    // Keep the point under the cursor (or the viewport centre) in place.
    const a = anchor || {
      x: this.root.clientWidth / 2,
      y: this.root.clientHeight / 2,
    };
    const sx = (this.root.scrollLeft + a.x) / this.zoom;
    const sy = (this.root.scrollTop + a.y) / this.zoom;

    this.zoom = next;
    this._applyZoom();

    this.root.scrollLeft = sx * next - a.x;
    this.root.scrollTop = sy * next - a.y;

    this._scheduleBgRerender();
    this._emitZoom();
  }

  _applyZoom() {
    this.page.style.transform = `scale(${this.zoom})`;
    // box-sizing is border-box, so the stage's own 20px padding has to be
    // added on top of the scaled page or the page overflows its content box.
    this.stage.style.width = `${A4_W * this.zoom + STAGE_PAD * 2}px`;
    this.stage.style.height = `${A4_H * this.zoom + STAGE_PAD * 2}px`;
  }

  zoomIn() { this.setZoom(this.zoom * ZOOM_STEP); }
  zoomOut() { this.setZoom(this.zoom / ZOOM_STEP); }

  zoomFit() {
    const pad = STAGE_PAD * 2;
    const availW = this.root.clientWidth - pad;
    const availH = this.root.clientHeight - pad;
    if (availW <= 0 || availH <= 0) return;
    const z = Math.min(availW / (A4_W + FIT_MARGIN), availH / (A4_H + FIT_MARGIN));
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    this._applyZoom();
    this.root.scrollTop = 0;
    this.root.scrollLeft = 0;
    this._scheduleBgRerender();
    this._emitZoom();
  }

  _emitZoom() {
    this.root.dispatchEvent(new CustomEvent('zoomchange', {
      detail: { zoom: this.zoom },
      bubbles: true,
    }));
  }

  _onWheel = (e) => {
    // Ctrl+wheel is the browser's own page zoom; leave it alone.
    if (e.ctrlKey || e.metaKey) return;
    // Plain wheel over the sheet means zoom, as in Act 3.
    if (e.shiftKey) return;
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
    const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    this.setZoom(this.zoom * factor, anchor);
  };
}

export { ZOOM_MIN, ZOOM_MAX };
