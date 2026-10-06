/**
 * Text wrapping and vertical placement for sheet fields.
 *
 * A direct port of `_wrap_text` and the baseline math inside
 * `_draw_field_text` from Act 3's utils/pdf_utils.py. Widths come from a
 * `measure(text, size)` callback so the same code can be driven by pdf-lib's
 * `font.widthOfTextAtSize` during export and by a canvas context on screen.
 *
 * Act 3 has NO shrink-to-fit anywhere: text that does not fit simply
 * overflows the box. Only `ability` fields clip, and they truncate rather
 * than scale. That is preserved here.
 */

import { ascentDescent, glyphHeight } from './font-metrics.js';

export const FIELD_TEXT_PAD_LEFT = 3.0;
export const FIELD_TEXT_PAD_RIGHT = 3.0;
export const FIELD_DEFAULT_LINE_HEIGHT_MULT = 1.3;
export const FIELD_EDGE_PAD = 1.0;

export const ABILITY_PAD = 3.0;
export const ABILITY_TITLE_LINE_HEIGHT_MULT = 1.25;
export const ABILITY_BLOCK_GAP_MULT = 0.2;

export const BOLD_EMUL_STROKE_SCALE = 0.04;
export const BOLD_EMUL_MIN_STROKE = 0.25;
export const BOLD_EMUL_X_SHIFT_SCALE = 0.5;

export const DECO_STROKE_SCALE = 0.06;
export const DECO_MIN_STROKE = 0.4;
export const UNDERLINE_Y_OFFSET = 0.12;
export const STRIKE_Y_OFFSET = 0.30;

export const LABEL_Y_OFFSET = 2.0;
export const FALLBACK_CHAR_WIDTH_SCALE = 0.55;

export const NOTE_ITALIC_SHEAR = 0.2126;

/** Python's str.split() with no argument: any whitespace run, empties dropped. */
const WS = /[\s-]+/;

/** Stroke width used by the synthetic-bold double draw. */
export function boldStrokeWidth(size) {
  return Math.max(BOLD_EMUL_MIN_STROKE, size * BOLD_EMUL_STROKE_SCALE);
}

/** Stroke width used by underline and strikethrough. */
export function decoStrokeWidth(size) {
  return Math.max(DECO_MIN_STROKE, size * DECO_STROKE_SCALE);
}

/**
 * Wrap `text` to `maxW`, honouring explicit newlines.
 *
 *  - paragraphs split on \n, \r\n and \r
 *  - words are packed until the line would exceed maxW
 *  - a single word wider than maxW is broken character by character
 *  - an invalid maxW (0, negative, NaN) disables wrapping entirely and just
 *    returns the explicit lines — Act 3 does this so a bad wrap width does
 *    not degenerate into one word per line
 *
 * @param {(s: string, size: number) => number} measure
 * @returns {string[]} always at least one entry
 */
export function wrapText(measure, size, text, maxW, maxChars) {
  let src = text == null ? '' : String(text);
  if (maxChars > 0) src = [...src].slice(0, maxChars).join('');
  if (!src) return [''];

  const maxWf = Number(maxW);
  if (!(maxWf > 0)) {
    // Catches 0, negatives and NaN.
    return src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  const w = (s) => (s ? measure(s, size) : 0);

  const splitLongWord = (word) => {
    if (w(word) <= maxWf) return [word];
    const chunks = [];
    let buf = '';
    for (const ch of word) {
      if (w(buf + ch) <= maxWf) buf += ch;
      else {
        if (buf) chunks.push(buf);
        buf = ch;
      }
    }
    if (buf) chunks.push(buf);
    return chunks.length ? chunks : [word];
  };

  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const result = [];
  for (const paragraph of src.split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(WS)) {
      if (!word) continue;                      // Python's split() drops empties
      for (const chunk of splitLongWord(word)) {
        const cand = current ? current + ' ' + chunk : chunk;
        if (w(cand) <= maxWf) current = cand;
        else {
          if (current) result.push(current);
          current = chunk;
        }
      }
    }
    if (current) result.push(current);
  }
  return result.length ? result : [''];
}

/**
 * Work out the wrapped lines and the first baseline for a field.
 *
 * Returns coordinates in PDF space (bottom-left origin), where `pdfY` is the
 * field's bottom edge: `pdfY = A4_H - field.y - field.height`.
 *
 * The vertical maths is Qt's, not ReportLab's — see font-metrics.js. Note
 * that for a single-line field `totalH` is one glyph box even when the text
 * wrapped onto several lines; that is what Act 3 does.
 */
export function fieldTextLayout(field, value, measure, metrics, pdfY) {
  const fs = field.font_size;
  const maxW = field.wrap_width > 0 ? field.wrap_width : field.width - 6;
  const lines = wrapText(measure, fs, value, maxW, field.max_chars);

  const { ascent } = ascentDescent(metrics, fs);
  const glyphH = glyphHeight(metrics, fs);

  const lhMult = field.line_height || FIELD_DEFAULT_LINE_HEIGHT_MULT;
  const lh = fs * lhMult;

  const fieldTop = pdfY + field.height;
  const fieldH = field.height;

  const isMultiline = Boolean(field.allow_multiline);
  const totalH = isMultiline ? glyphH + (lines.length - 1) * lh : glyphH;

  const valign = field.valign || 'center';
  // Qt leaves ~1px of breathing room at the clamped edge for a single-line
  // widget, so the text never touches the border.
  const edgePad = isMultiline ? 0.0 : FIELD_EDGE_PAD;

  let baselineTop;
  if (valign === 'top') baselineTop = ascent + edgePad;
  else if (valign === 'bottom') baselineTop = fieldH - totalH + ascent - edgePad;
  else baselineTop = (fieldH - totalH) / 2 + ascent;

  return { lines, lh, fs, firstBaselineY: fieldTop - baselineTop };
}

/**
 * Horizontal anchor for a line, plus how it should be aligned.
 * Mirrors the three branches at the end of `_draw_field_text`.
 */
export function fieldTextAnchor(field, pdfX) {
  if (field.alignment === 'center') {
    return { x: pdfX + field.width / 2, align: 'center' };
  }
  if (field.alignment === 'right') {
    return { x: pdfX + field.width - FIELD_TEXT_PAD_RIGHT, align: 'right' };
  }
  return { x: pdfX + FIELD_TEXT_PAD_LEFT, align: 'left' };
}

/**
 * Lay out an `ability` field's blocks into positioned lines.
 *
 * Content is `[{type:"title"|"text", content:"…"}, …]`. Each block starts on
 * its own line. Rendering stops dead the moment a line would fall below the
 * bottom padding — Act 3 truncates rather than scaling, and callers must not
 * "improve" on that.
 *
 * @returns {{runs: Array, }} runs: {text, x, y, size, bold, italic, color, align}
 */
export function abilityLayout(field, blocks, measure, pdfX, pdfY) {
  const pad = ABILITY_PAD;
  const maxW = field.width - 2 * pad;
  let topY = pdfY + field.height - pad;
  const bottom = pdfY + pad;
  const runs = [];

  for (const block of blocks) {
    const btype = block.type || 'text';
    const content = String(block.content == null ? '' : block.content).trim();

    let fs, bold, italic, color, align, lhMult;
    if (btype === 'title') {
      fs = field.ability_title_font_size;
      bold = field.ability_title_bold;
      italic = field.ability_title_italic;
      color = field.ability_title_color;
      align = field.ability_title_alignment;
      lhMult = ABILITY_TITLE_LINE_HEIGHT_MULT;
    } else {
      fs = field.font_size;
      bold = field.bold;
      italic = field.italic;
      color = field.text_color;
      align = field.alignment;
      lhMult = field.line_height || FIELD_DEFAULT_LINE_HEIGHT_MULT;
    }

    const lh = fs * lhMult;
    const lines = content
      ? wrapText(measure, fs, content, maxW, btype === 'text' ? field.max_chars : 0)
      : [];

    for (const line of lines) {
      const drawY = topY - fs;
      if (drawY < bottom) return { runs };      // clipped — stop entirely

      let x, alignMode;
      if (align === 'center') { x = pdfX + pad + maxW / 2.0; alignMode = 'center'; }
      else if (align === 'right') { x = pdfX + pad + maxW; alignMode = 'right'; }
      else { x = pdfX + pad; alignMode = 'left'; }

      runs.push({ text: line, x, y: drawY, size: fs, bold, italic, color, align: alignMode });
      topY -= lh;
    }

    // A block always ends with a gap so the next one starts on a new line;
    // an empty block still consumes a full line.
    topY -= lines.length ? lh * ABILITY_BLOCK_GAP_MULT : lh;
    if (topY < bottom) return { runs };
  }

  return { runs };
}

/** Parse an ability field's stored value, with Act 3's fallbacks. */
export function parseAbilityBlocks(raw) {
  const src = raw || '[]';
  try {
    const blocks = JSON.parse(src);
    return Array.isArray(blocks) ? blocks : [];
  } catch (e) {
    return [{ type: 'text', content: src }];
  }
}

/**
 * Destination rect for an image inside a field, matching CSS object-fit.
 * `fit_mode` is one of stretch | contain | cover (cover is the default).
 */
export function fitImageRect(iw, ih, x, y, w, h, fitMode) {
  const ai = iw / Math.max(ih, 1);
  const ab = w / Math.max(h, 1);
  let dw, dh;
  if (fitMode === 'stretch') return { x, y, w, h };
  if (fitMode === 'contain') {
    if (ai > ab) { dw = w; dh = Math.max(w / ai, 1); }
    else { dh = h; dw = Math.max(h * ai, 1); }
  } else {
    if (ai > ab) { dh = h; dw = Math.max(h * ai, 1); }
    else { dw = w; dh = Math.max(w / ai, 1); }
  }
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

/** Act 3 only paints a field background when it is not white. */
export function hasVisibleBg(bgColor) {
  const bg = (bgColor || '#ffffff').toLowerCase();
  return bg !== '#ffffff' && bg !== '#fff' && bg !== 'white';
}
