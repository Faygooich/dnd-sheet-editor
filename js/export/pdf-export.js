/**
 * PDF export — the browser counterpart of Act 3's utils/pdf_utils.py.
 *
 * Act 3 draws a ReportLab overlay, then merges the background underneath with
 * pikepdf's `add_overlay`. pdf-lib collapses that into one step: the
 * background page is copied into the output document and the overlay is drawn
 * straight onto it, because pdf-lib appends to the existing content stream.
 * The background therefore stays vector and never rasterises, and the
 * embedded-font loss Act 3's comments describe on 3rd+ pages cannot happen.
 *
 * Measurement note. pdf-lib's own `widthOfTextAtSize` applies GPOS kerning,
 * but `drawText` emits a plain glyph string whose advances come from the /W
 * array — so the two disagree. Widths here are summed from the advances of
 * the glyph run fontkit actually produces, which is exactly what gets drawn.
 * For Cyrillic that matches ReportLab to within 0.002 pt; for Latin the
 * script font's contextual alternates make it a few percent narrower than
 * Act 3, which renders better rather than worse.
 */

import {
  A4_W, A4_H, PAGE_KIND_NOTE_TEMPLATE, STAT_DISPLAY_NAMES,
} from '../core/sheet-model.js';
import { readTtfMetrics } from './font-metrics.js';
import {
  fieldTextLayout, fieldTextAnchor, abilityLayout, parseAbilityBlocks,
  fitImageRect, hasVisibleBg, wrapText,
  boldStrokeWidth, BOLD_EMUL_X_SHIFT_SCALE, LABEL_Y_OFFSET,
  DECO_MIN_STROKE, DECO_STROKE_SCALE, UNDERLINE_Y_OFFSET, STRIKE_Y_OFFSET,
  NOTE_ITALIC_SHEAR,
} from './text-layout.js';
import { loadBinary, loadImageBytes } from '../io/asset-paths.js';

const FONT_REGULAR = 'assets/fonts/segoesc.ttf';
const FONT_BOLD = 'assets/fonts/segoescb.ttf';

const PHOTO_PLACEHOLDER_BG = '#1e1430';
const PHOTO_PLACEHOLDER_FG = '#6a2a9a';
const NOTE_TEXT_COLOR = '#000000';

/** Field types that never reach the PDF. */
const SKIPPED_TYPES = new Set(['hidden_number', 'hidden_bool']);

// ── colour helpers ───────────────────────────────────────────────────────────

function hexToRgb(PDFLib, hex) {
  const s = String(hex || '#000000').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6) || '000000', 16);
  if (Number.isNaN(n)) return PDFLib.rgb(0, 0, 0);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ── font plumbing ────────────────────────────────────────────────────────────

/**
 * OpenType features switched off when shaping text.
 *
 * Segoe Script ships `calt`/`clig`/`liga`/`kern`, and fontkit applies them by
 * default — which swaps in the font's connected letterforms and kern pairs.
 * ReportLab does none of that, so leaving them on made every glyph in the
 * exported page differ in shape from Act 3's export (positions stayed put;
 * the letterforms changed). With them off, the glyph ids match the nominal
 * per-codepoint glyphs exactly and widths match ReportLab to within 0.002 pt.
 *
 * css/canvas.css turns the same features off for on-screen text, so the
 * editor, the exported PDF and Act 3's PDF all agree.
 */
const SHAPING_FEATURES_OFF = {
  calt: false, clig: false, liga: false, rlig: false, kern: false,
};

/**
 * Build a width measurer over the glyph run pdf-lib will draw.
 * Memoised, because wrapText probes many substrings per field.
 */
function makeMeasurer(fkFont) {
  const cache = new Map();
  const upem = fkFont.unitsPerEm || 2048;
  return (text, size) => {
    if (!text) return 0;
    let units = cache.get(text);
    if (units === undefined) {
      try {
        units = fkFont.layout(text, SHAPING_FEATURES_OFF)
          .glyphs.reduce((a, g) => a + g.advanceWidth, 0);
      } catch (e) {
        // Degrade the way Act 3 does when a font will not measure.
        units = text.length * upem * 0.55;
      }
      cache.set(text, units);
    }
    return (units / upem) * size;
  };
}

async function prepareFonts(doc, PDFLib, fontkit) {
  doc.registerFontkit(fontkit);

  const regBytes = await loadBinary(FONT_REGULAR);
  let boldBytes;
  try {
    boldBytes = await loadBinary(FONT_BOLD);
  } catch (e) {
    // Segoe Script ships regular and bold in one family; if the bold file is
    // missing, reuse the regular so bold text does not fall back to a
    // visibly different face — the same trick _init_fonts() plays.
    boldBytes = regBytes;
  }

  const embedOpts = { subset: true, features: SHAPING_FEATURES_OFF };
  const regular = await doc.embedFont(regBytes, embedOpts);
  const bold = await doc.embedFont(boldBytes, embedOpts);

  const fkReg = fontkit.create(new Uint8Array(regBytes));
  const fkBold = fontkit.create(new Uint8Array(boldBytes));

  return {
    regular,
    bold,
    metrics: readTtfMetrics(regBytes),
    metricsBold: readTtfMetrics(boldBytes),
    measureRegular: makeMeasurer(fkReg),
    measureBold: makeMeasurer(fkBold),
    pick(isBold) { return isBold ? this.bold : this.regular; },
    measureFor(isBold) { return isBold ? this.measureBold : this.measureRegular; },
    metricsFor(isBold) { return isBold ? this.metricsBold : this.metrics; },
  };
}

// ── low-level drawing ────────────────────────────────────────────────────────

/**
 * Draw one line of text with an alignment anchor.
 *
 * `boldEmulate` reproduces Act 3's synthetic-bold double draw. Note the
 * asymmetry being preserved: `_draw_str` (used for LEFT alignment) skips the
 * double draw when a real bold face is registered, while
 * `_draw_centred_str_at` / `_draw_right_str_at` do not check and always
 * double-draw. Centre- and right-aligned bold text is therefore slightly
 * heavier than left-aligned bold text in Act 3, and that is matched here.
 */
function drawAligned(page, PDFLib, opts) {
  const { text, x, y, align, size, font, color, measure, boldEmulate } = opts;
  if (!text) return;

  const w = align === 'left' ? 0 : measure(text, size);
  let drawX = x;
  if (align === 'center') drawX = x - w / 2;
  else if (align === 'right') drawX = x - w;

  const draw = (dx) => page.drawText(text, { x: dx, y, size, font, color });
  draw(drawX);
  if (boldEmulate) draw(drawX + boldStrokeWidth(size) * BOLD_EMUL_X_SHIFT_SCALE);
}

function drawRect(page, PDFLib, x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
  const o = { x, y, width: w, height: h };
  if (fill) o.color = fill;
  else o.opacity = 0;                       // border-only: no fill at all
  if (stroke) {
    o.borderColor = stroke;
    o.borderWidth = lineWidth;
  }
  page.drawRectangle(o);
}

// ── per-field rendering ──────────────────────────────────────────────────────

function renderLabel(page, PDFLib, field, fonts, pdfX, labelY) {
  const text = field.label || field.name;
  if (!text) return;
  page.drawText(text, {
    x: pdfX,
    y: labelY + LABEL_Y_OFFSET,
    size: field.label_font_size,
    font: fonts.pick(field.label_bold),
    color: hexToRgb(PDFLib, field.label_color),
  });
}

function renderFieldText(page, PDFLib, field, value, fonts, pdfX, pdfY) {
  const isBold = Boolean(field.bold);
  const font = fonts.pick(isBold);
  const measure = fonts.measureFor(isBold);
  const color = hexToRgb(PDFLib, field.text_color);

  const { lines, lh, fs, firstBaselineY } =
    fieldTextLayout(field, value, measure, fonts.metricsFor(isBold), pdfY);
  const { x, align } = fieldTextAnchor(field, pdfX);

  // See drawAligned(): only the centre/right paths double-draw in Act 3.
  const boldEmulate = isBold && align !== 'left';

  let y = firstBaselineY;
  for (const line of lines) {
    drawAligned(page, PDFLib, {
      text: line, x, y, align, size: fs, font, color, measure, boldEmulate,
    });
    y -= lh;
  }
}

function renderAbilityField(page, PDFLib, field, raw, fonts, pdfX, pdfY) {
  const blocks = parseAbilityBlocks(raw);

  if (hasVisibleBg(field.bg_color)) {
    drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
      { fill: hexToRgb(PDFLib, field.bg_color) });
  }
  if (field.show_border) {
    drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
      { stroke: hexToRgb(PDFLib, field.border_color) });
  }

  // A single measurer cannot serve both weights, so lay out with the regular
  // one and re-anchor per run using the run's own weight.
  const { runs } = abilityLayout(field, blocks, fonts.measureRegular, pdfX, pdfY);
  for (const run of runs) {
    const measure = fonts.measureFor(run.bold);
    drawAligned(page, PDFLib, {
      text: run.text,
      x: run.x,
      y: run.y,
      align: run.align,
      size: run.size,
      font: fonts.pick(run.bold),
      color: hexToRgb(PDFLib, run.color),
      measure,
      // The ability path in Act 3 checks the font name, so a real bold face
      // means no double draw at any alignment.
      boldEmulate: false,
    });
  }
}

/**
 * Empty photo slot: a dark plate with a small camera glyph.
 *
 * Note that `placeholder_icon` is deliberately NOT consulted here. Act 3's
 * `_draw_photo_placeholder` always draws the camera; the flag only suppresses
 * it in the on-screen widget (see ui/field-widgets.js). Honouring it here
 * would make the exported page differ from Act 3's.
 */
function drawPhotoPlaceholder(page, PDFLib, field, pdfX, pdfY) {
  drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
    { fill: hexToRgb(PDFLib, PHOTO_PLACEHOLDER_BG) });

  const cx = pdfX + field.width / 2;
  const cy = pdfY + field.height / 2;
  const s = Math.min(field.width, field.height) * 0.28;
  const fg = hexToRgb(PDFLib, PHOTO_PLACEHOLDER_FG);

  page.drawRectangle({
    x: cx - s * 0.7, y: cy - s * 0.42, width: s * 1.4, height: s * 0.84,
    opacity: 0, borderColor: fg, borderWidth: 1, borderRadius: 2,
  });
  page.drawCircle({ x: cx, y: cy, size: s * 0.2, opacity: 0, borderColor: fg, borderWidth: 1 });
}

async function renderPhotoField(page, PDFLib, doc, field, source, pdfX, pdfY) {
  if (field.show_border) {
    drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
      { stroke: hexToRgb(PDFLib, field.border_color) });
  }

  let embedded = null;
  if (source) {
    try {
      const { bytes, kind } = await loadImageBytes(source);
      embedded = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch (e) {
      embedded = null;
    }
  }
  if (!embedded) {
    drawPhotoPlaceholder(page, PDFLib, field, pdfX, pdfY);
    return;
  }

  const r = fitImageRect(
    embedded.width, embedded.height,
    pdfX, pdfY, field.width, field.height, field.fit_mode,
  );

  // Clip to the field box so a `cover` fit does not bleed, then multiply-blend
  // the photo onto the parchment the way Act 3 does.
  const { pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } = PDFLib;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(pdfX, pdfY),
    lineTo(pdfX + field.width, pdfY),
    lineTo(pdfX + field.width, pdfY + field.height),
    lineTo(pdfX, pdfY + field.height),
    closePath(),
    clip(),
    endPath(),
  );
  page.drawImage(embedded, {
    x: r.x, y: r.y, width: r.w, height: r.h,
    blendMode: PDFLib.BlendMode ? PDFLib.BlendMode.Multiply : undefined,
  });
  page.pushOperators(popGraphicsState());
}

/** The photo source for a field: a data: URI, a resolvable path, or null. */
function photoSourceFor(field, sheet, instance) {
  if (field.field_type === 'photo_static') return field.static_image_path || null;
  if (instance) return instance.values[field.name] || null;
  return sheet.getRawValue(field.name) || null;
}

async function renderField(page, PDFLib, doc, field, sheet, allValues, fonts, instance) {
  const pdfX = field.x;
  const pdfY = A4_H - field.y - field.height;   // top-left origin → bottom-left

  if (field.isPhoto()) {
    await renderPhotoField(
      page, PDFLib, doc, field, photoSourceFor(field, sheet, instance), pdfX, pdfY,
    );
    return;
  }

  if (field.field_type === 'ability') {
    const raw = instance
      ? (instance.values[field.name] || '')
      : sheet.getRawValue(field.name);
    renderAbilityField(page, PDFLib, field, raw, fonts, pdfX, pdfY);
    return;
  }

  if (field.label_position !== 'none' && (field.label || field.name)) {
    renderLabel(page, PDFLib, field, fonts, pdfX, pdfY + field.height);
  }

  if (hasVisibleBg(field.bg_color)) {
    drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
      { fill: hexToRgb(PDFLib, field.bg_color) });
  }
  if (field.show_border) {
    drawRect(page, PDFLib, pdfX, pdfY, field.width, field.height,
      { stroke: hexToRgb(PDFLib, field.border_color) });
  }

  // A stats field prints the Russian name of whichever ability is selected.
  const value = field.field_type === 'stats'
    ? (STAT_DISPLAY_NAMES[sheet.getRawValue(field.name)] || '')
    : (allValues[field.name] || '');

  if (value) renderFieldText(page, PDFLib, field, value, fonts, pdfX, pdfY);
}

// ── note pages ───────────────────────────────────────────────────────────────

function drawNoteStroke(page, PDFLib, stroke) {
  const pts = Array.isArray(stroke.points) ? stroke.points : [];
  if (!pts.length) return;

  const color = hexToRgb(PDFLib, stroke.color || '#000000');
  const width = Math.max(Number(stroke.width) || 0, 0.3);

  // A lone point still has to show up as a dot, so give it a 0.1pt stub.
  const path = pts.length === 1
    ? [pts[0], [pts[0][0] + 0.1, pts[0][1]]]
    : pts;

  const { pushGraphicsState, popGraphicsState, setLineCap, setLineJoin } = PDFLib;
  page.pushOperators(pushGraphicsState(), setLineCap(1), setLineJoin(1));
  const d = path
    .map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${A4_H - y}`)
    .join(' ');
  page.drawSvgPath(d, {
    borderColor: color,
    borderWidth: width,
    borderLineCap: PDFLib.LineCapStyle ? PDFLib.LineCapStyle.Round : undefined,
    x: 0,
    y: A4_H,
    scale: 1,
  });
  page.pushOperators(popGraphicsState());
}

/**
 * Draw one pre-measured text run onto a note page.
 *
 * Runs come from the editor's own DOM layout (see ui/note-editor.js), so the
 * exported page matches what was on screen. Act 3 had to instantiate Qt at
 * export time to get the equivalent numbers.
 */
function drawNoteRun(page, PDFLib, doc, fonts, run) {
  const font = fonts.pick(run.bold);
  const measure = fonts.measureFor(run.bold);
  const color = hexToRgb(PDFLib, run.color || NOTE_TEXT_COLOR);
  const size = run.size;
  const width = measure(run.text, size);

  if (run.italic) {
    // Segoe Script has no italic face, so slant it with the CTM, as Act 3 does.
    const { pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, NOTE_ITALIC_SHEAR, 1, run.x, run.y),
    );
    page.drawText(run.text, { x: 0, y: 0, size, font, color });
    page.pushOperators(popGraphicsState());
  } else {
    page.drawText(run.text, { x: run.x, y: run.y, size, font, color });
  }

  const deco = Math.max(DECO_MIN_STROKE, size * DECO_STROKE_SCALE);
  if (run.underline) {
    const uy = run.y - size * UNDERLINE_Y_OFFSET;
    page.drawLine({
      start: { x: run.x, y: uy }, end: { x: run.x + width, y: uy },
      thickness: deco, color,
    });
  }
  if (run.strike) {
    const sy = run.y + size * STRIKE_Y_OFFSET;
    page.drawLine({
      start: { x: run.x, y: sy }, end: { x: run.x + width, y: sy },
      thickness: deco, color,
    });
  }
}

/**
 * Strokes first, then text — ink must never cover text, matching the
 * editor's z-order (strokes z=1, frames z=2).
 */
function renderNotePage(page, PDFLib, doc, fonts, instance, noteTextRuns) {
  for (const item of instance.content) {
    if (item && item.type === 'stroke') drawNoteStroke(page, PDFLib, item);
  }
  if (!noteTextRuns) return;
  for (const item of instance.content) {
    if (!item || item.type !== 'text') continue;
    for (const run of noteTextRuns(item)) drawNoteRun(page, PDFLib, doc, fonts, run);
  }
}

// ── background pages ─────────────────────────────────────────────────────────

const RASTER_RE = /\.(png|jpe?g|bmp|webp|tiff?)$/i;

function isRasterRef(ref) {
  if (!ref) return false;
  if (ref.startsWith('data:')) return !ref.startsWith('data:application/pdf');
  return RASTER_RE.test(ref);
}

/**
 * Add the page for one sheet page and return it.
 *
 * A PDF background is copied in whole so it stays vector; a raster one is
 * stretched over a fresh A4 page with no aspect preservation, exactly as
 * `c.drawImage(..., preserveAspectRatio=False)` does in Act 3.
 */
async function addBackgroundPage(doc, PDFLib, bgRef, cache) {
  if (bgRef && !isRasterRef(bgRef)) {
    try {
      let src = cache.get(bgRef);
      if (!src) {
        src = await PDFLib.PDFDocument.load(await loadBinary(bgRef));
        cache.set(bgRef, src);
      }
      const [copied] = await doc.copyPages(src, [0]);
      doc.addPage(copied);
      return copied;
    } catch (e) {
      // Fall through to a blank page rather than failing the whole export.
    }
  }

  const page = doc.addPage([A4_W, A4_H]);

  if (bgRef && isRasterRef(bgRef)) {
    try {
      const { bytes, kind } = await loadImageBytes(bgRef);
      const img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      page.drawImage(img, { x: 0, y: 0, width: A4_W, height: A4_H });
    } catch (e) {
      /* blank page */
    }
  }
  return page;
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Render a sheet to PDF bytes.
 *
 * @param {SheetModel} sheet
 * @param {object} [opts]
 * @param {(frame: object) => Array} [opts.noteTextRuns]
 *   Supplies laid-out runs for a note text frame. Provided by the note editor;
 *   when absent, note text frames are skipped and only strokes are drawn.
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function exportSheetToPdf(sheet, opts = {}) {
  const PDFLib = globalThis.PDFLib;
  const fontkit = globalThis.fontkit;
  if (!PDFLib) throw new Error('pdf-lib не загружен');
  if (!fontkit) throw new Error('fontkit не загружен');

  const doc = await PDFLib.PDFDocument.create();
  const fonts = await prepareFonts(doc, PDFLib, fontkit);

  const docValues = sheet.evaluateAllFormulas();
  const pages = sheet.iterPdfPages();
  const bgCache = new Map();

  let done = 0;
  for (const [kind, instance] of pages) {
    const bgRef = sheet.backgroundForKind(kind);
    const page = await addBackgroundPage(doc, PDFLib, bgRef, bgCache);

    if (instance) {
      renderNotePage(page, PDFLib, doc, fonts, instance, opts.noteTextRuns);
    } else {
      const values = docValues;
      for (const field of sheet.fieldsForKind(kind)) {
        if (SKIPPED_TYPES.has(field.field_type)) continue;
        try {
          await renderField(page, PDFLib, doc, field, sheet, values, fonts, null);
        } catch (e) {
          // One bad field must not take down the export, as in Act 3.
          console.warn(`Поле «${field.name}» не отрисовано:`, e);
        }
      }
    }

    done++;
    if (opts.onProgress) opts.onProgress(done, pages.length);
  }

  return doc.save();
}

/** Per-note formula scope, for callers that need it (note-bound fields). */
export function valuesForPage(sheet, kind, instance) {
  if (instance && kind === PAGE_KIND_NOTE_TEMPLATE) {
    return sheet.evaluateAllFormulasForNote(instance.id);
  }
  return sheet.evaluateAllFormulas();
}

export { wrapText };
